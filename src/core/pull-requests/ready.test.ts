import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { noPullRequestRule, prCommands, prWrites, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prReady } from "./ready"

const { use, run } = writeHarness(prReady)

const READY: GhRule = { match: "^pr ready" }
const URL = "https://github.com/octo/hello/pull/7"

describe("marking ready", () => {
  test("a draft becomes ready with one gh pr ready", async () => {
    const installed = use([repositoryRule(), stateRule({ isDraft: true }), READY])
    expect(await run({ pr: "7" })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      draft: false,
      changed: true,
      foreign: false,
    })
    expect(prCommands(installed).map((call) => call.args)).toEqual([["pr", "ready", "7", "--repo", "octo/hello"]])
  })

  test("undo turns a ready pull request back into a draft", async () => {
    const installed = use([repositoryRule(), stateRule({ isDraft: false }), READY])
    expect(await run({ pr: "#7", undo: true })).toMatchObject({ draft: true, changed: true })
    expect(prCommands(installed).map((call) => call.args)).toEqual([
      ["pr", "ready", "7", "--repo", "octo/hello", "--undo"],
    ])
  })

  test("a pull request that is ready already is left alone: no write", async () => {
    const installed = use([repositoryRule(), stateRule({ isDraft: false }), READY])
    expect(await run({ pr: "7" })).toMatchObject({ draft: false, changed: false, url: URL })
    expect(prWrites(installed)).toEqual([])
  })

  test("a draft that is a draft already is left alone with undo: no write", async () => {
    const installed = use([repositoryRule(), stateRule({ isDraft: true }), READY])
    expect(await run({ pr: "7", undo: true })).toMatchObject({ draft: true, changed: false })
    expect(prWrites(installed)).toEqual([])
  })

  test("a pull request URL names its own repository", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), stateRule({ isDraft: true }), READY])
    expect((await run({ pr: "https://github.com/other/thing/pull/7" })).repo).toBe("other/thing")
    expect(prCommands(installed)[0]!.args.slice(2, 5)).toEqual(["7", "--repo", "other/thing"])
  })
})

describe("refusals", () => {
  test.each(["CLOSED", "MERGED"])("a %s pull request is invalid_argument, and nothing is written", async (state) => {
    const installed = use([repositoryRule(), stateRule({ state, isDraft: true }), READY])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      `octo/hello#7 is ${state.toLowerCase()}; only an open pull request can change between draft and ready.`,
    )
    expect(prWrites(installed)).toEqual([])
  })

  test("a pull request that does not exist is not_found", async () => {
    const installed = use([repositoryRule(), noPullRequestRule(), READY])
    expect((await failure(run({ pr: "7" }))).code).toBe("not_found")
    expect(prWrites(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), stateRule(), READY])
    expect((await failure(run({ pr: "7" }))).code).toBe("forbidden")
    expect(prCommands(installed)).toEqual([])
  })

  test("an issue URL is invalid_argument", async () => {
    use([repositoryRule(), stateRule(), READY])
    expect((await failure(run({ pr: "https://github.com/octo/hello/issues/7" }))).code).toBe("invalid_argument")
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), stateRule({ isDraft: true }), { match: "^pr ready", stderr: "HTTP 500", code: 1 }])
    expect((await failure(run({ pr: "7" }))).code).toBe("upstream_error")
  })
})

test("a repository of someone else is foreign", async () => {
  use([repositoryRule({ viewer: "me" }), stateRule({ isDraft: true }), READY])
  expect((await run({ pr: "7" })).foreign).toBe(true)
})
