import { describe, expect, test } from "bun:test"
import { commands, createdRule, labelRule, writeRules } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

describe("the relations", () => {
  test("a bare parent number means the new issue's repository", async () => {
    const installed = use(writeRules(createdRule(7)))
    const result = await run({ title: "T", parent: "#3" })
    expect(result.relations).toEqual({ parent: "octo/hello#3", blocked_by: [] })
    expect(commands(installed).at(-1)!.args).toEqual(["issue", "edit", "7", "--repo", "octo/hello", "--parent", "3"])
  })

  test("a parent in another repository goes to gh as its URL", async () => {
    const installed = use(writeRules(createdRule(7)))
    const result = await run({ title: "T", parent: "other/thing#9" })
    expect(result.relations.parent).toBe("other/thing#9")
    expect(commands(installed).at(-1)!.args.slice(-2)).toEqual(["--parent", "https://github.com/other/thing/issues/9"])
  })

  test("each blocker is its own call, in order, after the kind and the parent", async () => {
    const installed = use(writeRules(createdRule(7), labelRule(true)))
    const result = await run({
      title: "T",
      kind: "bug",
      parent: "1",
      blocked_by: ["2", "https://github.com/other/thing/issues/5", " "],
    })
    expect(result.relations).toEqual({ parent: "octo/hello#1", blocked_by: ["octo/hello#2", "other/thing#5"] })
    expect(commands(installed).map((call) => call.args.slice(5))).toEqual([
      ["T", "--body-file", "-"],
      ["--add-label", "type:bug"],
      ["--parent", "1"],
      ["--add-blocked-by", "2"],
      ["--add-blocked-by", "https://github.com/other/thing/issues/5"],
    ])
  })

  test("a failed parent is an error beside the issue; the blockers still go through", async () => {
    use(writeRules(createdRule(7), { match: "--parent", stderr: "HTTP 422: parent is not allowed", code: 1 }))
    const result = await run({ title: "T", parent: "1", blocked_by: ["2"] })
    expect(result.issue.number).toBe(7)
    expect(result.relations).toEqual({ parent: null, blocked_by: ["octo/hello#2"] })
    expect(Object.keys(result.errors)).toEqual(["parent"])
    expect(result.errors.parent).toContain("parent is not allowed")
  })

  test("a failed blocker is named in the error, and the others are kept", async () => {
    use(writeRules(createdRule(7), { match: "--add-blocked-by 3", stderr: "could not resolve issue 3", code: 1 }))
    const result = await run({ title: "T", blocked_by: ["2", "3", "4"] })
    expect(result.relations.blocked_by).toEqual(["octo/hello#2", "octo/hello#4"])
    expect(Object.keys(result.errors)).toEqual(["blocked_by"])
    expect(result.errors.blocked_by).toContain("octo/hello#3")
  })
})
