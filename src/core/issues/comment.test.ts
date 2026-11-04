import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { commands, repositoryRule, sent, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueComment } from "./comment"

const { use, run } = writeHarness(issueComment)

const URL = "https://github.com/octo/hello/issues/12#issuecomment-99"
const COMMENTED: GhRule = { match: "^issue comment", stdout: `${URL}\n` }

describe("commenting", () => {
  test("the body goes on stdin, and the comment's URL comes back", async () => {
    const installed = use([repositoryRule(), COMMENTED])
    const body = "Fixed in `main`.\n\n- one\n- two"
    expect(await run({ issue: "#12", body })).toEqual({ repo: "octo/hello", issue: 12, url: URL, foreign: false })
    expect(commands(installed)).toEqual([
      { args: ["issue", "comment", "12", "--repo", "octo/hello", "--body-file", "-"], stdin: body },
    ])
  })

  test("the permission is read first", async () => {
    const installed = use([repositoryRule(), COMMENTED])
    await run({ issue: "12", body: "Hi" })
    expect(sent(installed)[0]!.join(" ")).toContain("viewerPermission")
  })

  test("an issue URL names its own repository, and the repo argument serves a bare number", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), COMMENTED])
    expect((await run({ issue: "https://github.com/other/thing/issues/3", body: "Hi" })).repo).toBe("other/thing")
    expect((await run({ issue: "4", repo: "other/thing", body: "Hi" })).issue).toBe(4)
    expect(commands(installed).map((call) => call.args.slice(2, 5))).toEqual([
      ["3", "--repo", "other/thing"],
      ["4", "--repo", "other/thing"],
    ])
  })

  test("a gh that prints no URL leaves it empty, as the comment exists", async () => {
    use([repositoryRule(), { match: "^issue comment" }])
    expect((await run({ issue: "12", body: "Hi" })).url).toBe("")
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), { match: "^issue comment", stderr: "HTTP 404: Not Found", code: 1 }])
    expect((await failure(run({ issue: "12", body: "Hi" }))).code).toBe("not_found")
  })
})

describe("permission", () => {
  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), COMMENTED])
    expect((await failure(run({ issue: "12", body: "Hi" }))).code).toBe("forbidden")
    expect(writes(installed)).toEqual([])
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), COMMENTED])
    expect((await run({ issue: "12", body: "Hi" })).foreign).toBe(true)
  })
})

describe("arguments", () => {
  test.each([
    ["a blank body", { issue: "12", body: " \n" }],
    ["a pull request URL", { issue: "https://github.com/octo/hello/pull/12", body: "Hi" }],
    ["a reference that is none", { issue: "twelve", body: "Hi" }],
    ["a reference and a repo that disagree", { issue: "a/b#1", repo: "c/d", body: "Hi" }],
    ["a missing body", { issue: "12" }],
    ["an unknown argument", { issue: "12", body: "Hi", title: "T" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use([repositoryRule(), COMMENTED])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
