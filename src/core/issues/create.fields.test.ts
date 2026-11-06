import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { failure } from "../../testing/issue-fixtures"
import {
  ISSUE_FIELD_DEFINITIONS,
  ISSUE_FIELD_MUTATION,
  ISSUE_FIELD_VALUES,
  commands,
  createdRule,
  issueFieldDefinitionsRule,
  issueFieldValuesRule,
  issueFieldsRule,
  issueFieldsSetRule,
  sent,
  writeRules,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

const VALUES: GhRule = issueFieldValuesRule([
  { __typename: "IssueFieldSingleSelectValue", field: { name: "Priority" }, name: "High" },
  { __typename: "IssueFieldNumberValue", field: { name: "Effort" }, value: 3 },
])

const base = (...rules: GhRule[]): GhRule[] =>
  writeRules(...rules, createdRule(7), issueFieldsRule(), issueFieldDefinitionsRule(), issueFieldsSetRule(), VALUES)

const mutation = (installed: ReturnType<typeof use>): string =>
  sent(installed)
    .map((args) => args.join(" "))
    .find((call) => call.includes(ISSUE_FIELD_MUTATION)) ?? ""

describe("setting issue fields", () => {
  test("values are set after the create in one mutation with the right inputs", async () => {
    const installed = use(base())
    const result = await run({
      title: "Crash on save",
      issue_fields: { Priority: "High", Effort: 3 },
    })
    expect(result.issue).toEqual({
      number: 7,
      url: "https://github.com/octo/hello/issues/7",
      title: "Crash on save",
    })
    expect(result.issue_fields).toEqual({ Priority: "High", Effort: 3 })
    expect(result.errors).toEqual({})
    expect(mutation(installed)).toContain(
      'issueFields:[{fieldId:"IF_priority",singleSelectOptionId:"IFO_high"},{fieldId:"IF_effort",numberValue:3}]',
    )
    expect(mutation(installed)).toContain("issueId=I_12")
  })

  test("each type becomes its input, matched by name without regard to case", async () => {
    const installed = use(base())
    const result = await run({
      title: "T",
      issue_fields: {
        Effort: "2.5",
        "target date": "2026-12-01",
        Sprint: "Sprint 4",
        Components: ["ui", "API"],
        Priority: "low",
      },
    })
    expect(result.issue_fields).toEqual({ Priority: "High", Effort: 3 })
    expect(mutation(installed)).toContain(
      'issueFields:[{fieldId:"IF_effort",numberValue:2.5},{fieldId:"IF_target",dateValue:"2026-12-01"},{fieldId:"IF_sprint",textValue:"Sprint 4"},{fieldId:"IF_components",multiSelectOptionIds:["IFO_ui","IFO_api"]},{fieldId:"IF_priority",singleSelectOptionId:"IFO_low"}]',
    )
  })
})

describe("order", () => {
  test("definitions are read before gh issue create, and mutation runs after", async () => {
    const installed = use(base())
    await run({ title: "T", issue_fields: { Priority: "High" } })
    const calls = sent(installed).map((args) => args.join(" "))
    const defIndex = calls.findIndex((call) => new RegExp(ISSUE_FIELD_DEFINITIONS).test(call))
    const createIndex = calls.findIndex((call) => call.startsWith("issue create"))
    const mutationIndex = calls.findIndex((call) => new RegExp(ISSUE_FIELD_MUTATION).test(call))
    expect(defIndex).toBeGreaterThan(-1)
    expect(createIndex).toBeGreaterThan(defIndex)
    expect(mutationIndex).toBeGreaterThan(createIndex)
  })
})

describe("refusals come before gh issue create and before milestone create", () => {
  test.each([
    ["an unknown field", { issue_fields: { Severity: "High" } }, 'no issue field "Severity"'],
    ["an unknown option", { issue_fields: { Priority: "Urgent" } }, 'no option "Urgent"'],
    ["a list for a single select", { issue_fields: { Priority: ["High"] } }, "takes one option name"],
    ["a text that is not a number", { issue_fields: { Effort: "lots" } }, "takes a number"],
    ["a date that does not exist", { issue_fields: { "Target date": "2026-02-30" } }, "YYYY-MM-DD"],
    ["a field named twice", { issue_fields: { Priority: "High", priority: "Low" } }, "twice"],
    ["a blank field name", { issue_fields: { " ": "High" } }, "blank field name"],
  ])("%s", async (_name, args, message) => {
    const installed = use(base())
    const error = await failure(run({ title: "T", milestone: "v9", create_milestone: true, ...args }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(commands(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("milestones"))).toBe(false)
  })

  test("a repository of a personal account has no issue fields", async () => {
    const installed = use([issueFieldDefinitionsRule(null), ...base()])
    const error = await failure(
      run({ title: "T", milestone: "v9", create_milestone: true, issue_fields: { Priority: "High" } }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("octo/hello has no issue fields")
    expect(commands(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("milestones"))).toBe(false)
  })
})

describe("failures", () => {
  test("a failing mutation gives errors.issue_fields with the issue returned and issue_fields: null", async () => {
    use([
      { match: ISSUE_FIELD_MUTATION, stdout: gqlErrors([{ type: "FORBIDDEN", message: "No permission" }]) },
      ...base(),
    ])
    const result = await run({ title: "T", issue_fields: { Effort: 1 } })
    expect(result.issue.number).toBe(7)
    expect(result.issue_fields).toBeNull()
    expect(Object.keys(result.errors)).toEqual(["issue_fields"])
    expect(result.errors.issue_fields).toContain("forbidden")
    expect(result.errors.issue_fields).toContain("No permission")
  })

  test("a failing read-back leaves issue_fields null without an error", async () => {
    use([{ match: ISSUE_FIELD_VALUES, stderr: "HTTP 500", code: 1 }, ...base()])
    const result = await run({ title: "T", issue_fields: { Effort: 1 } })
    expect(result.issue.number).toBe(7)
    expect(result.issue_fields).toBeNull()
    expect(result.errors).toEqual({})
  })
})

describe("no issue_fields", () => {
  test("no definitions read, issue_fields: null", async () => {
    const installed = use(base())
    const result = await run({ title: "T" })
    expect(result.issue_fields).toBeNull()
    expect(sent(installed).some((args) => args.join(" ").includes("issueField"))).toBe(false)
  })

  test("empty issue_fields object: no definitions read, issue_fields: null", async () => {
    const installed = use(base())
    const result = await run({ title: "T", issue_fields: {} })
    expect(result.issue_fields).toBeNull()
    expect(sent(installed).some((args) => args.join(" ").includes("issueField"))).toBe(false)
  })
})
