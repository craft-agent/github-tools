import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { noPullRequestRule, prCommands, prWrites, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prClose } from "./close"

const { use, run } = writeHarness(prClose)

const CLOSE = ["pr", "close", "7", "--repo", "octo/hello"]
const CLOSED: GhRule = { match: "^pr close" }
const URL = "https://github.com/octo/hello/pull/7"

describe("closing", () => {
  test("an open pull request is closed with one gh pr close, and its branch is not deleted", async () => {
    const installed = use([repositoryRule(), stateRule(), CLOSED])
    expect(await run({ pr: "7" })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      state: "closed",
      changed: true,
      foreign: false,
    })
    expect(prCommands(installed).map((call) => call.args)).toEqual([CLOSE])
  })

  test("the comment goes with the close", async () => {
    const installed = use([repositoryRule(), stateRule(), CLOSED])
    await run({ pr: "#7", comment: " Superseded by #9. " })
    expect(prCommands(installed).map((call) => call.args)).toEqual([[...CLOSE, "--comment", "Superseded by #9."]])
  })

  test("a blank comment is not sent", async () => {
    const installed = use([repositoryRule(), stateRule(), CLOSED])
    await run({ pr: "7", comment: "  " })
    expect(prCommands(installed).map((call) => call.args)).toEqual([CLOSE])
  })

  test("a pull request URL names its own repository", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), stateRule(), CLOSED])
    expect((await run({ pr: "https://github.com/other/thing/pull/7" })).repo).toBe("other/thing")
    expect(prCommands(installed)[0]!.args.slice(2, 5)).toEqual(["7", "--repo", "other/thing"])
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), stateRule(), { match: "^pr close", stderr: "HTTP 500", code: 1 }])
    expect((await failure(run({ pr: "7" }))).code).toBe("github_error")
  })
})

describe("a pull request that is closed or merged already", () => {
  test.each([
    ["CLOSED", "closed"],
    ["MERGED", "merged"],
  ])("%s is left as it is: no write, the comment is not posted", async (state, word) => {
    const installed = use([repositoryRule(), stateRule({ state }), CLOSED])
    expect(await run({ pr: "7", comment: "Bye" })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      state: word,
      changed: false,
      foreign: false,
    })
    expect(prWrites(installed)).toEqual([])
  })
})

describe("refusals", () => {
  test("a pull request that does not exist is not_found", async () => {
    const installed = use([repositoryRule(), noPullRequestRule(), CLOSED])
    expect((await failure(run({ pr: "7" }))).code).toBe("not_found")
    expect(prWrites(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), stateRule(), CLOSED])
    expect((await failure(run({ pr: "7" }))).code).toBe("forbidden")
    expect(prCommands(installed)).toEqual([])
  })

  test("an issue URL is invalid_argument", async () => {
    use([repositoryRule(), stateRule(), CLOSED])
    expect((await failure(run({ pr: "https://github.com/octo/hello/issues/7" }))).code).toBe("invalid_argument")
  })
})

test("a repository of someone else is foreign", async () => {
  use([repositoryRule({ viewer: "me" }), stateRule(), CLOSED])
  expect((await run({ pr: "7" })).foreign).toBe(true)
})
