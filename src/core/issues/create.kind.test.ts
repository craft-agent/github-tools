import { describe, expect, test } from "bun:test"
import {
  commands,
  createdRule,
  issueTypesRule,
  labelRule,
  repositoryRule,
  writeRules,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

const CREATE = ["issue", "create", "--repo", "octo/hello", "--title", "Crash on save", "--body-file", "-"]
const EDIT = ["issue", "edit", "7", "--repo", "octo/hello"]
const TYPE_REFUSED = "GraphQL: Issue type is not enabled for this repository"

describe("the kind", () => {
  test("an Issue Type of that name is set with --type after the issue exists", async () => {
    const installed = use([
      createdRule(7),
      repositoryRule(),
      issueTypesRule("Bug", "Feature"),
      { match: "^issue edit" },
    ])
    const result = await run({ title: "Crash on save", kind: "bug" })
    expect(result.kind).toEqual({ name: "Bug", via: "type" })
    expect(commands(installed).map((call) => call.args)).toEqual([CREATE, [...EDIT, "--type", "Bug"]])
  })

  test("else the type:<kind> label is created when missing, then added", async () => {
    const installed = use(writeRules(createdRule(7), labelRule(false), { match: "^label create" }))
    const result = await run({ title: "Crash on save", kind: "Bug" })
    expect(result.kind).toEqual({ name: "type:bug", via: "label" })
    expect(commands(installed).map((call) => call.args)).toEqual([
      CREATE,
      ["label", "create", "type:bug", "--repo", "octo/hello"],
      [...EDIT, "--add-label", "type:bug"],
    ])
  })

  test("a label that exists is not created again", async () => {
    const installed = use(writeRules(createdRule(7), labelRule(true)))
    await run({ title: "T", kind: "bug" })
    expect(commands(installed).some((call) => call.args[0] === "label")).toBe(false)
  })

  test("a type GitHub refuses falls back to the label, and the call reports where it landed", async () => {
    const installed = use([
      createdRule(7),
      { match: "--type Bug", stderr: TYPE_REFUSED, code: 1 },
      repositoryRule(),
      issueTypesRule("Bug"),
      labelRule(true),
      { match: "^issue edit" },
    ])
    const result = await run({ title: "Crash on save", kind: "bug" })
    expect(result.kind).toEqual({ name: "type:bug", via: "label" })
    expect(result.errors).toEqual({})
    expect(commands(installed).map((call) => call.args)).toEqual([
      CREATE,
      [...EDIT, "--type", "Bug"],
      [...EDIT, "--add-label", "type:bug"],
    ])
  })

  test("a kind that fails otherwise is an error beside the issue, which is still returned", async () => {
    use([createdRule(7), { match: "--type Bug", stderr: "HTTP 500", code: 1 }, repositoryRule(), issueTypesRule("Bug")])
    const result = await run({ title: "T", kind: "bug" })
    expect(result.issue.number).toBe(7)
    expect(result.kind).toBeNull()
    expect(Object.keys(result.errors)).toEqual(["kind"])
    expect(result.errors.kind).toStartWith("github_error: ")
  })

  test("an Issue Types read that fails is a kind error too", async () => {
    use([createdRule(7), repositoryRule(), { match: "issueTypes\\(first", stderr: "HTTP 502", code: 1 }])
    const result = await run({ title: "T", kind: "bug" })
    expect(result.issue.number).toBe(7)
    expect(Object.keys(result.errors)).toEqual(["kind"])
  })
})
