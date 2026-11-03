import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { editedRule, milestonesRule, repositoryRule, sent, writeRules, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueEdit } from "./edit"

const { use, run } = writeHarness(issueEdit)

/** The rules every call needs, after the ones a test adds, with an edit that prints issue 12's URL. */
const base = (...rules: GhRule[]): GhRule[] => writeRules(...rules, editedRule(12))

describe("permission", () => {
  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use([repositoryRule({ permission: "TRIAGE" }), editedRule(12), milestonesRule("v1")])
    const error = await failure(run({ issue: "12", title: "T", milestone: "v9", create_milestone: true }))
    expect(error.code).toBe("forbidden")
    expect(writes(installed)).toEqual([])
    expect(sent(installed)).toHaveLength(1)
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), editedRule(12)])
    expect((await run({ issue: "12", title: "T" })).foreign).toBe(true)
  })
})

describe("arguments", () => {
  test.each([
    ["body with append_body", { body: "a", append_body: "b" }],
    ["milestone with remove_milestone", { milestone: "v1", remove_milestone: true }],
    ["create_milestone without milestone", { title: "T", create_milestone: true }],
    ["a blank milestone", { title: "T", milestone: " " }],
    ["a label added and removed", { add_labels: ["Bug"], remove_labels: ["x", "bug"] }],
    ["an assignee added and removed", { add_assignees: ["bob"], remove_assignees: ["Bob"] }],
    ["a label with a comma", { add_labels: ["a,b"] }],
    ["an assignee with a double quote", { remove_assignees: ['b"ob'] }],
    ["a blank title", { title: " " }],
    ["a blank title beside other changes", { title: "", add_labels: ["x"] }],
    ["nothing to change", {}],
    ["only empty lists and blanks", { append_body: "  ", add_labels: [], remove_assignees: [" "] }],
    ["remove_milestone: false alone", { remove_milestone: false }],
    ["a pull request URL", { title: "T", issue: "https://github.com/octo/hello/pull/12" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use(base())
    expect((await failure(run({ issue: "12", ...args }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a missing issue or an unknown argument is invalid_argument", async () => {
    use([])
    for (const args of [{ title: "T" }, { issue: "12", title: "T", state: "closed" }]) {
      expect((await failure(run(args))).code).toBe("invalid_argument")
    }
  })
})
