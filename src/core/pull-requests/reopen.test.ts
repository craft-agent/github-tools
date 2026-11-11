import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { noPullRequestRule, prCommands, prWrites, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prReopen } from "./reopen"

const { use, run } = writeHarness(prReopen)

const REOPEN = ["pr", "reopen", "7", "--repo", "octo/hello"]
const REOPENED: GhRule = { match: "^pr reopen" }
const URL = "https://github.com/octo/hello/pull/7"

describe("reopening", () => {
  test("a closed pull request is reopened with one gh pr reopen", async () => {
    const installed = use([repositoryRule(), stateRule({ state: "CLOSED" }), REOPENED])
    expect(await run({ pr: "7" })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      state: "open",
      changed: true,
      foreign: false,
    })
    expect(prCommands(installed).map((call) => call.args)).toEqual([REOPEN])
  })

  test("the comment goes with the reopen", async () => {
    const installed = use([repositoryRule(), stateRule({ state: "CLOSED" }), REOPENED])
    await run({ pr: "#7", comment: " Back on. " })
    expect(prCommands(installed).map((call) => call.args)).toEqual([[...REOPEN, "--comment", "Back on."]])
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), stateRule({ state: "CLOSED" }), { match: "^pr reopen", stderr: "HTTP 500", code: 1 }])
    expect((await failure(run({ pr: "7" }))).code).toBe("upstream_error")
  })
})

describe("a pull request that is open already", () => {
  test("is left as it is: no write, the comment is not posted", async () => {
    const installed = use([repositoryRule(), stateRule(), REOPENED])
    expect(await run({ pr: "7", comment: "Hi" })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      state: "open",
      changed: false,
      foreign: false,
    })
    expect(prWrites(installed)).toEqual([])
  })
})

describe("refusals", () => {
  test("a merged pull request cannot be reopened, and nothing is written", async () => {
    const installed = use([repositoryRule(), stateRule({ state: "MERGED" }), REOPENED])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("octo/hello#7 is merged; a merged pull request cannot be reopened.")
    expect(prWrites(installed)).toEqual([])
  })

  test("a pull request that does not exist is not_found", async () => {
    const installed = use([repositoryRule(), noPullRequestRule(), REOPENED])
    expect((await failure(run({ pr: "7" }))).code).toBe("not_found")
    expect(prWrites(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), stateRule({ state: "CLOSED" }), REOPENED])
    expect((await failure(run({ pr: "7" }))).code).toBe("forbidden")
    expect(prCommands(installed)).toEqual([])
  })

  test("an issue URL is invalid_argument", async () => {
    use([repositoryRule(), stateRule({ state: "CLOSED" }), REOPENED])
    expect((await failure(run({ pr: "https://github.com/octo/hello/issues/7" }))).code).toBe("invalid_argument")
  })
})

test("a repository of someone else is foreign", async () => {
  use([repositoryRule({ viewer: "me" }), stateRule({ state: "CLOSED" }), REOPENED])
  expect((await run({ pr: "7" })).foreign).toBe(true)
})
