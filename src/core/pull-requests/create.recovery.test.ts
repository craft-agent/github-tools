import { describe, expect, test } from "bun:test"
import { HEAD_SHA, branchRule, defaultBranchRule } from "../../testing/develop-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { prCommands, prCreatedRule, prEditedRule, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prCreate } from "./create"

const { use, run } = writeHarness(prCreate)

const OUTAGE = "pull request update failed: GraphQL: Something went wrong while executing your query."
const FAILED_CREATE: GhRule = { match: "^pr create", stderr: OUTAGE, code: 1 }
const FOUND = JSON.stringify([{ number: 47, url: "https://github.com/octo/hello/pull/47" }])
/** The duplicate check finds nothing; every later look for the pull request answers `later`. */
const listing = (later: GhRule): GhRule[] => [{ match: "^pr list", stdout: "[]", times: 1 }, later]

/** The rules of a call that finds both branches and the default branch `main`, after the ones a test adds. */
const base = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  repositoryRule(),
  defaultBranchRule("main"),
  branchRule("octo/hello", "main", true),
  branchRule("octo/hello", "feature", true),
  { match: "^pr list", stdout: "[]" },
  prCreatedRule(7),
  prEditedRule(7),
  stateRule(),
]

const listCalls = (installed: Parameters<typeof sent>[0]) =>
  prCommands(installed).filter((call) => call.args[1] === "list")

describe("labels, people and the milestone", () => {
  test("are a step after the pull request is made: one edit, before the read-back", async () => {
    const installed = use(base())
    const result = await run({ head: "feature", title: "T", labels: ["feature"] })
    expect(result.errors).toEqual({})
    const calls = sent(installed).map((args) => args.join(" "))
    const create = calls.findIndex((call) => call.startsWith("pr create"))
    const edit = calls.findIndex((call) => call.startsWith("pr edit"))
    const read = calls.findIndex((call, index) => index > create && call.includes("headRefOid"))
    expect(calls[edit]).toBe("pr edit 7 --repo octo/hello --add-label feature")
    expect(create).toBeLessThan(edit)
    expect(edit).toBeLessThan(read)
  })

  test("are not edited when there are none", async () => {
    const installed = use(base())
    await run({ head: "feature", title: "T" })
    expect(prCommands(installed).map((call) => call.args[1])).toEqual(["list", "create"])
  })

  test("a failing edit is listed under errors.metadata, and the pull request is still returned", async () => {
    use(base({ match: "^pr edit", stderr: "boom", code: 1 }))
    const result = await run({ head: "feature", title: "T", labels: ["feature"], assignees: ["@me"] })
    expect(result.pr).toEqual({ number: 7, url: "https://github.com/octo/hello/pull/7", title: "T" })
    expect(result.head_sha).toBe(HEAD_SHA)
    expect(result.errors).toEqual({ metadata: "github_error: gh failed (exit 1): boom" })
  })
})

describe("a pull request that gh pr create reported a failure for", () => {
  test("is looked up and returned when it exists, with the failure under errors.create", async () => {
    const installed = use(base(FAILED_CREATE, ...listing({ match: "^pr list", stdout: FOUND }), prEditedRule(47)))
    const result = await run({ head: "feature", title: "T", labels: ["feature"] })
    expect(result.pr).toEqual({ number: 47, url: "https://github.com/octo/hello/pull/47", title: "T" })
    expect(result.errors).toEqual({ create: `github_error: gh failed (exit 1): ${OUTAGE}` })
    expect(listCalls(installed)).toHaveLength(2)
    expect(listCalls(installed)[1]!.args).toEqual(listCalls(installed)[0]!.args)
    // The follow-up the failed create did not finish is done by the step after it.
    expect(prCommands(installed).at(-1)!.args.join(" ")).toBe("pr edit 47 --repo octo/hello --add-label feature")
  })

  test.each([
    ["a 404", "gh: Not Found (HTTP 404)", "not_found"],
    ["a rate limit", "API rate limit exceeded", "rate_limited"],
    ["a conflict", "HTTP 409: Conflict", "stale"],
  ])("%s is looked up too", async (_name, stderr, code) => {
    use(base({ match: "^pr create", stderr, code: 1 }, ...listing({ match: "^pr list", stdout: FOUND })))
    const result = await run({ head: "feature", title: "T" })
    expect(result.pr.number).toBe(47)
    expect(result.errors.create).toStartWith(`${code}: `)
  })

  test("a create that printed no URL is looked up as well", async () => {
    use(base({ match: "^pr create", stdout: "created\n" }, ...listing({ match: "^pr list", stdout: FOUND })))
    const result = await run({ head: "feature", title: "T" })
    expect(result.pr.number).toBe(47)
    expect(result.errors.create).toContain("did not print the pull request")
  })

  test("that is not found is the original error", async () => {
    const installed = use(base(FAILED_CREATE))
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("github_error")
    expect(error.message).toContain(OUTAGE)
    expect(listCalls(installed)).toHaveLength(2)
  })

  test("whose lookup fails is the original error", async () => {
    use(base(FAILED_CREATE, ...listing({ match: "^pr list", stderr: "lookup failed", code: 1 })))
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("github_error")
    expect(error.message).toContain(OUTAGE)
    expect(error.message).not.toContain("lookup failed")
  })

  test.each([
    ["forbidden", "HTTP 403: Resource not accessible by integration"],
    ["unauthenticated", "To get started with GitHub CLI, please run: gh auth login"],
  ] as const)("a %s refusal is not looked up: nothing was made", async (code, stderr) => {
    const installed = use(
      base({ match: "^pr create", stderr, code: 1 }, ...listing({ match: "^pr list", stdout: FOUND })),
    )
    expect((await failure(run({ head: "feature", title: "T" }))).code).toBe(code)
    expect(listCalls(installed)).toHaveLength(1)
  })
})
