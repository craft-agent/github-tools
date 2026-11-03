import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { commands, issueFieldsRule, repositoryRule, sent, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueClose } from "./close"

const { use, run } = writeHarness(issueClose)

const CLOSE = ["issue", "close", "12", "--repo", "octo/hello"]
const CLOSED: GhRule = { match: "^issue close" }

describe("closing", () => {
  test.each([
    ["completed", "completed"],
    ["not_planned", "not planned"],
    ["duplicate", "duplicate"],
  ] as const)("reason %s is sent to gh as %p", async (reason, spelled) => {
    const installed = use([repositoryRule(), issueFieldsRule(), CLOSED])
    expect(await run({ issue: "12", reason })).toEqual({
      repo: "octo/hello",
      issue: 12,
      state_reason: reason,
      changed: true,
      foreign: false,
    })
    expect(commands(installed).map((call) => call.args)).toEqual([[...CLOSE, "--reason", spelled]])
  })

  test("the state is read first, and the comment goes with the close", async () => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "OPEN" }), CLOSED])
    await run({ issue: "12", reason: "completed", comment: "Shipped in v2." })
    const calls = sent(installed).map((args) => args.join(" "))
    expect(calls[0]).toContain("viewerPermission")
    expect(calls[1]).toContain("stateReason")
    expect(calls[2]).toBe(`${CLOSE.join(" ")} --reason completed --comment Shipped in v2.`)
    expect(commands(installed)[0]!.args.slice(-2)).toEqual(["--comment", "Shipped in v2."])
  })

  test("a duplicate names its original: a bare number in the issue's own repository, else a URL", async () => {
    const installed = use([repositoryRule(), issueFieldsRule(), CLOSED])
    const same = await run({ issue: "12", reason: "duplicate", duplicate_of: "#5" })
    await run({ issue: "12", reason: "duplicate", duplicate_of: "other/thing#7" })
    expect(same.state_reason).toBe("duplicate")
    expect(commands(installed).map((call) => call.args.slice(5))).toEqual([
      ["--reason", "duplicate", "--duplicate-of", "5"],
      ["--reason", "duplicate", "--duplicate-of", "https://github.com/other/thing/issues/7"],
    ])
  })

  test("a bare duplicate_of means the issue's repository, not the working tree's", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), issueFieldsRule(), CLOSED])
    await run({ issue: "other/thing#12", reason: "duplicate", duplicate_of: "5" })
    expect(commands(installed)[0]!.args).toEqual([
      "issue",
      "close",
      "12",
      "--repo",
      "other/thing",
      "--reason",
      "duplicate",
      "--duplicate-of",
      "5",
    ])
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), issueFieldsRule(), { match: "^issue close", stderr: "HTTP 500", code: 1 }])
    expect((await failure(run({ issue: "12", reason: "completed" }))).code).toBe("github_error")
  })
})

describe("an issue that is closed already", () => {
  test.each<[string | null, "completed" | "not_planned" | "duplicate" | null]>([
    ["COMPLETED", "completed"],
    ["NOT_PLANNED", "not_planned"],
    ["DUPLICATE", "duplicate"],
    ["REOPENED", null],
    [null, null],
  ])("state reason %p is reported as %p, and nothing is sent", async (stateReason, reported) => {
    const installed = use([repositoryRule(), issueFieldsRule({ state: "CLOSED", stateReason }), CLOSED])
    const result = await run({ issue: "12", reason: "not_planned", comment: "Not posted." })
    expect(result).toEqual({ repo: "octo/hello", issue: 12, state_reason: reported, changed: false, foreign: false })
    expect(writes(installed)).toEqual([])
  })
})

describe("permission", () => {
  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), issueFieldsRule(), CLOSED])
    expect((await failure(run({ issue: "12", reason: "completed" }))).code).toBe("forbidden")
    expect(sent(installed)).toHaveLength(1)
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), issueFieldsRule(), CLOSED])
    expect((await run({ issue: "12", reason: "completed" })).foreign).toBe(true)
  })
})

describe("arguments", () => {
  test.each([
    ["no reason", { issue: "12" }],
    ["a reason that is not one", { issue: "12", reason: "not planned" }],
    ["duplicate_of with another reason", { issue: "12", reason: "completed", duplicate_of: "5" }],
    ["an issue as a duplicate of itself", { issue: "12", reason: "duplicate", duplicate_of: "octo/hello#12" }],
    [
      "a pull request as the original",
      { issue: "12", reason: "duplicate", duplicate_of: "https://github.com/a/b/pull/1" },
    ],
    ["a pull request URL", { issue: "https://github.com/octo/hello/pull/12", reason: "completed" }],
    ["an unknown argument", { issue: "12", reason: "completed", state: "closed" }],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args) => {
    const installed = use([repositoryRule(), issueFieldsRule(), CLOSED])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a blank duplicate_of or comment counts as not given", async () => {
    const installed = use([repositoryRule(), issueFieldsRule(), CLOSED])
    await run({ issue: "12", reason: "completed", duplicate_of: " ", comment: " " })
    expect(commands(installed)[0]!.args).toEqual([...CLOSE, "--reason", "completed"])
  })
})
