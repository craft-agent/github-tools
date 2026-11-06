import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { failure } from "../../testing/issue-fixtures"
import {
  ISSUE_FIELD_MUTATION,
  commands,
  editedRule,
  issueFieldDefinitionsRule,
  issueFieldValuesRule,
  issueFieldsRule,
  issueFieldsSetRule,
  sent,
  writeRules,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueEdit } from "./edit"

const { use, run } = writeHarness(issueEdit)

const EDIT = ["issue", "edit", "12", "--repo", "octo/hello"]

const VALUES: GhRule = issueFieldValuesRule([
  { __typename: "IssueFieldSingleSelectValue", field: { name: "Priority" }, name: "High" },
  { __typename: "IssueFieldNumberValue", field: { name: "Effort" }, value: 3 },
])

/** The rules an issue field edit needs, after the ones a test adds: the issue, the definitions, the mutation and the read-back. */
const base = (...rules: GhRule[]): GhRule[] =>
  writeRules(...rules, issueFieldsRule(), issueFieldDefinitionsRule(), issueFieldsSetRule(), VALUES, editedRule(12))

/** The calls as text, in order, for the ones that write: `gh issue edit` and the issue field mutation. */
const written = (installed: ReturnType<typeof use>): string[] =>
  sent(installed)
    .map((args) => args.join(" "))
    .filter((call) => call.startsWith("issue edit") || call.includes(ISSUE_FIELD_MUTATION))

const mutation = (installed: ReturnType<typeof use>): string =>
  sent(installed)
    .map((args) => args.join(" "))
    .find((call) => call.includes(ISSUE_FIELD_MUTATION)) ?? ""

describe("issue fields alone", () => {
  test("set: no gh issue edit runs, the url is the issue's, and the values come back", async () => {
    const installed = use(base())
    expect(await run({ issue: "12", issue_fields: { Priority: "High" } })).toEqual({
      repo: "octo/hello",
      issue: 12,
      url: "https://github.com/octo/hello/issues/12",
      changed: ["issue_fields"],
      kind: null,
      milestone: null,
      issue_fields: { Priority: "High", Effort: 3 },
      foreign: false,
    })
    expect(commands(installed)).toEqual([])
    expect(mutation(installed)).toContain('issueFields:[{fieldId:"IF_priority",singleSelectOptionId:"IFO_high"}]')
    expect(mutation(installed)).toContain("issueId=I_12")
  })

  test("clear: a delete input", async () => {
    const installed = use(base())
    const result = await run({ issue: "12", clear_issue_fields: ["priority"] })
    expect(result.changed).toEqual(["clear_issue_fields"])
    expect(commands(installed)).toEqual([])
    expect(mutation(installed)).toContain('issueFields:[{fieldId:"IF_priority",delete:true}]')
  })

  test("each type becomes its input, matched by name without regard to case", async () => {
    const installed = use(base())
    const result = await run({
      issue: "12",
      issue_fields: {
        Effort: "2.5",
        "target date": "2026-12-01",
        Sprint: "Sprint 4",
        Components: ["ui", "API"],
        Priority: "low",
      },
      clear_issue_fields: [],
    })
    expect(result.changed).toEqual(["issue_fields"])
    expect(written(installed)).toHaveLength(1)
    expect(mutation(installed)).toContain(
      'issueFields:[{fieldId:"IF_effort",numberValue:2.5},{fieldId:"IF_target",dateValue:"2026-12-01"},{fieldId:"IF_sprint",textValue:"Sprint 4"},{fieldId:"IF_components",multiSelectOptionIds:["IFO_ui","IFO_api"]},{fieldId:"IF_priority",singleSelectOptionId:"IFO_low"}]',
    )
  })

  test("set and clear share one mutation", async () => {
    const installed = use(base())
    const result = await run({
      issue: "12",
      issue_fields: { Priority: "High" },
      clear_issue_fields: ["Sprint", "Effort"],
    })
    expect(result.changed).toEqual(["issue_fields", "clear_issue_fields"])
    expect(written(installed)).toHaveLength(1)
    expect(mutation(installed)).toContain(
      'issueFields:[{fieldId:"IF_priority",singleSelectOptionId:"IFO_high"},{fieldId:"IF_sprint",delete:true},{fieldId:"IF_effort",delete:true}]',
    )
  })
})

describe("issue fields with other changes", () => {
  test("gh issue edit runs first, then the mutation", async () => {
    const installed = use(base())
    const result = await run({ issue: "12", title: "T", issue_fields: { Effort: 1 } })
    expect(result.changed).toEqual(["title", "issue_fields"])
    expect(commands(installed)).toEqual([{ args: [...EDIT, "--title", "T"], stdin: "" }])
    const calls = written(installed)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toStartWith("issue edit")
    expect(calls[1]).toContain(ISSUE_FIELD_MUTATION)
  })

  test("the issue is read once, for both the body and the node id", async () => {
    const installed = use(base(issueFieldsRule({ body: "Old" })))
    await run({ issue: "12", append_body: "New", issue_fields: { Effort: 1 } })
    expect(sent(installed).filter((args) => args.join(" ").includes("stateReason body labels"))).toHaveLength(1)
  })

  test("a mutation that fails after the edit says what was applied, keeping the code and the cause", async () => {
    const installed = use([
      { match: ISSUE_FIELD_MUTATION, stdout: gqlErrors([{ type: "FORBIDDEN", message: "No permission" }]) },
      ...base(),
    ])
    const error = await failure(run({ issue: "12", title: "T", add_labels: ["x"], issue_fields: { Effort: 1 } }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toStartWith(
      "The other changes (title, add_labels) were applied, but the issue fields were not: ",
    )
    expect(error.message).toContain("No permission")
    expect(error.cause).toBeInstanceOf(Error)
    expect(commands(installed)).toHaveLength(1)
  })

  test("a mutation that fails when nothing else was applied is thrown as it is", async () => {
    use([
      { match: ISSUE_FIELD_MUTATION, stdout: gqlErrors([{ type: "FORBIDDEN", message: "No permission" }]) },
      ...base(),
    ])
    const error = await failure(run({ issue: "12", issue_fields: { Effort: 1 } }))
    expect(error.code).toBe("forbidden")
    expect(error.message).not.toContain("were applied")
  })
})

describe("the read-back", () => {
  test("a read that fails leaves the values null, not the call failed", async () => {
    const installed = use([{ match: "issueFieldValues\\(first", stderr: "HTTP 500", code: 1 }, ...base()])
    const result = await run({ issue: "12", issue_fields: { Effort: 1 } })
    expect(result.issue_fields).toBeNull()
    expect(result.changed).toEqual(["issue_fields"])
    expect(written(installed)).toHaveLength(1)
  })

  test("without issue fields the result holds null and nothing about them is read", async () => {
    const installed = use(base())
    const result = await run({ issue: "12", title: "T" })
    expect(result.issue_fields).toBeNull()
    expect(sent(installed).some((args) => args.join(" ").includes("issueField"))).toBe(false)
  })
})

describe("refusals come before any write", () => {
  test.each([
    ["an unknown field", { issue_fields: { Severity: "High" } }, 'no issue field "Severity"'],
    ["an unknown option", { issue_fields: { Priority: "Urgent" } }, 'no option "Urgent"'],
    ["a list for a single select", { issue_fields: { Priority: ["High"] } }, "takes one option name"],
    ["a text that is not a number", { issue_fields: { Effort: "lots" } }, "takes a number"],
    ["a date that does not exist", { issue_fields: { "Target date": "2026-02-30" } }, "YYYY-MM-DD"],
    ["an empty multi select", { issue_fields: { Components: [] } }, "clear_issue_fields"],
    ["a field to clear that is unknown", { clear_issue_fields: ["Severity"] }, 'no issue field "Severity"'],
    ["a field named twice", { issue_fields: { Priority: "High", priority: "Low" } }, "twice"],
  ])("%s", async (_name, args, message) => {
    const installed = use(base())
    const error = await failure(run({ issue: "12", title: "T", ...args }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(written(installed)).toEqual([])
  })

  test("a repository of a personal account has no issue fields", async () => {
    const installed = use([issueFieldDefinitionsRule(null), ...base()])
    const error = await failure(run({ issue: "12", title: "T", issue_fields: { Priority: "High" } }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("octo/hello has no issue fields")
    expect(written(installed)).toEqual([])
  })

  test("a refused field creates no milestone", async () => {
    const installed = use(base())
    await failure(run({ issue: "12", milestone: "v9", create_milestone: true, issue_fields: { Severity: "x" } }))
    expect(sent(installed).some((args) => args.join(" ").includes("milestones"))).toBe(false)
  })
})
