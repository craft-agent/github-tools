import { describe, expect, test } from "bun:test"
import { DETAIL, failure } from "../../testing/issue-fixtures"
import { otherRepositoryRule, relationsRules } from "../../testing/relate-fixtures"
import { REPOSITORY, commands, repositoryRule, sent, writeRules, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueRelate } from "./relate"

const { use, run } = writeHarness(issueRelate)

const countOf = (calls: string[][], token: string): number =>
  calls.filter((args) => args.join(" ").includes(token)).length

describe("arguments", () => {
  test.each([
    ["a parent and remove_parent", { issue: "12", parent: "1", remove_parent: true }],
    ["a blank parent", { issue: "12", parent: "  " }],
    ["a sub-issue added and removed", { issue: "12", add_sub_issues: ["5"], remove_sub_issues: ["#5"] }],
    [
      "a blocker added and removed, spelled differently",
      { issue: "12", add_blocked_by: ["5"], remove_blocked_by: ["OCTO/hello#5"] },
    ],
    [
      "an issue blocking and unblocking by URL",
      { issue: "12", add_blocking: ["https://github.com/octo/hello/issues/5"], remove_blocking: ["5"] },
    ],
    ["the issue as its own parent", { issue: "12", parent: "12" }],
    [
      "the issue as its own sub-issue, by URL",
      { issue: "12", add_sub_issues: ["https://github.com/octo/hello/issues/12"] },
    ],
    ["the issue as its own blocker, qualified", { issue: "12", add_blocked_by: ["4", "octo/hello#12"] }],
    ["the issue removed from itself", { issue: "12", remove_blocking: ["12"] }],
    ["nothing at all", { issue: "12" }],
    ["empty lists", { issue: "12", add_sub_issues: [], remove_blocked_by: [] }],
    ["blank entries only", { issue: "12", add_blocking: [" ", ""] }],
    ["remove_parent: false alone", { issue: "12", remove_parent: false }],
    ["a pull request as a sub-issue", { issue: "12", add_sub_issues: ["https://github.com/octo/hello/pull/3"] }],
    ["a pull request URL as the issue", { issue: "https://github.com/octo/hello/pull/12", parent: "1" }],
    ["an unknown argument", { issue: "12", parent: "1", labels: ["x"] }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use(writeRules(...relationsRules()))
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("blank entries and repeats in a list are dropped", async () => {
    const installed = use(writeRules(...relationsRules()))
    const result = await run({ issue: "12", add_sub_issues: [" ", "5", "#5", "octo/hello#5"] })
    expect(result.sub_issues.added).toEqual(["octo/hello#5"])
    expect(commands(installed)).toHaveLength(1)
  })
})

describe("permission", () => {
  test("without write permission on the issue's repository nothing is read or written", async () => {
    const installed = use(writeRules(repositoryRule({ permission: "READ" }), ...relationsRules()))
    expect((await failure(run({ issue: "12", parent: "1" }))).code).toBe("forbidden")
    expect(sent(installed)).toHaveLength(1)
  })

  test("without write permission on another repository named, nothing is read or written", async () => {
    const installed = use(writeRules(otherRepositoryRule("other/thing", { permission: "READ" }), ...relationsRules()))
    const error = await failure(run({ issue: "12", add_sub_issues: ["5", "other/thing#9"] }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("other/thing")
    expect(commands(installed)).toEqual([])
    expect(countOf(sent(installed), DETAIL)).toBe(0)
  })

  test("a repository the viewer may write to is listed once, whatever the number of issues in it", async () => {
    const installed = use(writeRules(otherRepositoryRule("other/thing", { viewer: "me" }), ...relationsRules()))
    const result = await run({
      issue: "12",
      parent: "other/thing#1",
      add_sub_issues: ["https://github.com/other/thing/issues/2", "OTHER/thing#3", "octo/hello#4"],
      remove_blocked_by: ["other/thing#4"],
    })
    expect(result.other_repos).toEqual([{ repo: "other/thing", foreign: true }])
    expect(result.foreign).toBe(false)
    expect(countOf(sent(installed), REPOSITORY)).toBe(2)
  })

  test("another repository's issues are named by the repository's own spelling", async () => {
    const asked = { ...otherRepositoryRule("other/Thing"), match: `${REPOSITORY}[\\s\\S]*owner=other -f name=thing` }
    use(writeRules(asked, ...relationsRules()))
    const result = await run({ issue: "12", add_blocking: ["other/thing#4"] })
    expect(result.blocking.added).toEqual(["other/Thing#4"])
  })

  test("a repository that cannot be seen is not_found, before any write", async () => {
    const installed = use(
      writeRules(
        {
          ...otherRepositoryRule("other/thing"),
          stdout: JSON.stringify({ data: { viewer: { login: "octo" }, repository: null } }),
        },
        ...relationsRules(),
      ),
    )
    expect((await failure(run({ issue: "12", add_sub_issues: ["other/thing#9"] }))).code).toBe("not_found")
    expect(writes(installed)).toEqual([])
  })
})
