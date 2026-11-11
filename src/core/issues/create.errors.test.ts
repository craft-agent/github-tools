import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { commands, createdRule, sent, writeRules } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

describe("failures", () => {
  test("a gh that prints no issue URL is upstream_error, saying the issue may exist", async () => {
    use(writeRules({ match: "^issue create", stdout: "done\n" }))
    const error = await failure(run({ title: "T" }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("may exist")
  })

  test("a failing gh issue create is thrown, and no step follows", async () => {
    const installed = use(writeRules({ match: "^issue create", stderr: "HTTP 422: Validation Failed", code: 1 }))
    const error = await failure(run({ title: "T", kind: "bug", parent: "1" }))
    expect(error.message).toContain("Validation Failed")
    expect(commands(installed)).toHaveLength(1)
  })
})

describe("arguments", () => {
  test.each([
    ["a blank title", { title: "  " }],
    ["create_milestone without milestone", { title: "T", create_milestone: true }],
    ["a label with a comma", { title: "T", labels: ["a,b"] }],
    ["an assignee with a comma", { title: "T", assignees: ["a,b"] }],
    ["a label with a double quote", { title: "T", labels: ['say "hi"'] }],
    ["a label with a line break", { title: "T", labels: ["a\nb"] }],
    ["an assignee with a carriage return", { title: "T", assignees: ["a\rb"] }],
    ["an assignee with a double quote", { title: "T", assignees: ['b"ob'] }],
    ["a kind with a comma", { title: "T", kind: "a,b" }],
    ["a kind with a double quote", { title: "T", kind: 'a"b' }],
    ["a pull request as parent", { title: "T", parent: "https://github.com/octo/hello/pull/1" }],
    ["a blocker that is no reference", { title: "T", blocked_by: ["soon"] }],
    ["a parent naming a bad repository", { title: "T", parent: "not a repo#1" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use(writeRules(createdRule(7)))
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("an unknown argument or a missing title is invalid_argument", async () => {
    use([])
    for (const args of [{ title: "T", assignee: "bob" }, {}, { title: 3 }]) {
      expect((await failure(run(args))).code).toBe("invalid_argument")
    }
  })
})
