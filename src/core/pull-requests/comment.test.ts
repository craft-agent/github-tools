import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { prCommands } from "../../testing/pull-request-write-fixtures"
import { repositoryRule, sent, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prComment } from "./comment"

const { use, run } = writeHarness(prComment)

const URL = "https://github.com/octo/hello/pull/12#issuecomment-99"
const COMMENTED: GhRule = { match: "^pr comment", stdout: `${URL}\n` }

describe("commenting", () => {
  test("the body goes on stdin, and the comment's URL comes back", async () => {
    const installed = use([repositoryRule(), COMMENTED])
    const body = "Looks good.\n\n- one\n- two"
    expect(await run({ pr: "#12", body })).toEqual({
      repo: "octo/hello",
      pr: 12,
      url: URL,
      attachments: [],
      notes: [],
      foreign: false,
      errors: {},
    })
    expect(prCommands(installed)).toEqual([
      { args: ["pr", "comment", "12", "--repo", "octo/hello", "--body-file", "-"], stdin: body },
    ])
  })

  test("the permission is read first", async () => {
    const installed = use([repositoryRule(), COMMENTED])
    await run({ pr: "12", body: "Hi" })
    expect(sent(installed)[0]!.join(" ")).toContain("viewerPermission")
  })

  test("a pull request URL names its own repository, and the repo argument serves a bare number", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), COMMENTED])
    expect((await run({ pr: "https://github.com/other/thing/pull/3", body: "Hi" })).repo).toBe("other/thing")
    expect((await run({ pr: "4", repo: "other/thing", body: "Hi" })).pr).toBe(4)
    expect(prCommands(installed).map((call) => call.args.slice(2, 5))).toEqual([
      ["3", "--repo", "other/thing"],
      ["4", "--repo", "other/thing"],
    ])
  })

  test("a gh that prints no URL leaves it empty, as the comment exists", async () => {
    use([repositoryRule(), { match: "^pr comment" }])
    expect((await run({ pr: "12", body: "Hi" })).url).toBe("")
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), { match: "^pr comment", stderr: "HTTP 404: Not Found", code: 1 }])
    expect((await failure(run({ pr: "12", body: "Hi" }))).code).toBe("not_found")
  })
})

describe("permission", () => {
  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), COMMENTED])
    expect((await failure(run({ pr: "12", body: "Hi" }))).code).toBe("forbidden")
    expect(writes(installed)).toEqual([])
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), COMMENTED])
    expect((await run({ pr: "12", body: "Hi" })).foreign).toBe(true)
  })
})

describe("arguments", () => {
  test.each([
    ["a blank body", { pr: "12", body: " \n" }],
    ["an issue URL", { pr: "https://github.com/octo/hello/issues/12", body: "Hi" }],
    ["a reference that is none", { pr: "twelve", body: "Hi" }],
    ["a reference and a repo that disagree", { pr: "a/b#1", repo: "c/d", body: "Hi" }],
    ["a missing body", { pr: "12" }],
    ["an unknown argument", { pr: "12", body: "Hi", title: "T" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use([repositoryRule(), COMMENTED])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
