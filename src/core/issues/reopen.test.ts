import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { commands, issueFieldsRule, repositoryRule, sent, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueReopen } from "./reopen"

const { use, run } = writeHarness(issueReopen)

const REOPEN = ["issue", "reopen", "12", "--repo", "octo/hello"]
const REOPENED: GhRule = { match: "^issue reopen" }

describe("reopening", () => {
  test("a closed issue is reopened, after its state is read", async () => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "CLOSED", stateReason: "COMPLETED" }), REOPENED])
    expect(await run({ issue: "#12" })).toEqual({ repo: "octo/hello", issue: 12, changed: true, foreign: false })
    expect(commands(installed).map((call) => call.args)).toEqual([REOPEN])
    expect(sent(installed)[1]!.join(" ")).toContain("stateReason")
  })

  test("a comment goes with it", async () => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "CLOSED" }), REOPENED])
    await run({ issue: "12", comment: "It came back." })
    expect(commands(installed).map((call) => call.args)).toEqual([[...REOPEN, "--comment", "It came back."]])
  })

  test("an open issue is left as it is: nothing is sent, and the comment is not posted", async () => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "OPEN" }), REOPENED])
    expect(await run({ issue: "12", comment: "Not posted." })).toEqual({
      repo: "octo/hello",
      issue: 12,
      changed: false,
      foreign: false,
    })
    expect(writes(installed)).toEqual([])
  })

  test("an issue URL names its own repository", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), issueFieldsRule({ state: "CLOSED" }), REOPENED])
    expect((await run({ issue: "https://github.com/other/thing/issues/3" })).repo).toBe("other/thing")
    expect(commands(installed)[0]!.args).toEqual(["issue", "reopen", "3", "--repo", "other/thing"])
  })

  test("a failing gh is thrown", async () => {
    use([
      repositoryRule(),
      issueFieldsRule({ state: "CLOSED" }),
      { match: "^issue reopen", stderr: "HTTP 500", code: 1 },
    ])
    expect((await failure(run({ issue: "12" }))).code).toBe("upstream_error")
  })
})

describe("permission", () => {
  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), issueFieldsRule({ state: "CLOSED" }), REOPENED])
    expect((await failure(run({ issue: "12" }))).code).toBe("forbidden")
    expect(sent(installed)).toHaveLength(1)
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), issueFieldsRule({ state: "OPEN" })])
    expect((await run({ issue: "12" })).foreign).toBe(true)
  })
})

describe("arguments", () => {
  test.each([
    ["a pull request URL", { issue: "https://github.com/octo/hello/pull/12" }],
    ["a reference that is none", { issue: "twelve" }],
    ["no issue", {}],
    ["an unknown argument", { issue: "12", reason: "completed" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "CLOSED" }), REOPENED])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
