import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  apiPaths,
  expectedStack,
  inStack,
  pullRule,
  rawFullStack,
  stackFailureRule,
  stackPosts,
  stackRule,
  unstackRule,
} from "../../testing/stack-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { stackUnlink } from "./stack-unlink"

const { use, run } = writeHarness(stackUnlink)

const UNSTACK = "repos/octo/hello/stacks/5/unstack"
const MERGED = { state: "closed", merged_at: "2026-11-02T00:00:00Z" }

describe("taking a stack apart", () => {
  test("by number: the stack is read, then unstacked, and a stack that is gone has no remaining", async () => {
    const installed = use([repositoryRule(), stackRule(5, rawFullStack(5, [101, 102, 103])), unstackRule(5)])
    expect(await run({ stack: 5 })).toEqual({
      repo: "octo/hello",
      stack_number: 5,
      removed: [101, 102, 103],
      remaining: null,
      changed: true,
      foreign: false,
    })
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/stacks/5", UNSTACK])
    expect(stackPosts(installed)).toEqual([{ path: UNSTACK, body: null }])
  })

  test("by pull request: the stack is found through the pull request", async () => {
    const installed = use([
      repositoryRule(),
      pullRule(102, 101, inStack(5, 2, 3)),
      stackRule(5, rawFullStack(5, [101, 102, 103])),
      unstackRule(5),
    ])
    expect(await run({ pr: "#102" })).toMatchObject({ stack_number: 5, removed: [101, 102, 103], changed: true })
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/pulls/102", "repos/octo/hello/stacks/5", UNSTACK])
  })

  test("merged pull requests stay: removed lists the ones that left and remaining the ones that stayed", async () => {
    use([
      repositoryRule(),
      stackRule(5, rawFullStack(5, [101, 102, 103], { 101: MERGED })),
      unstackRule(5, rawFullStack(5, [101], { 101: MERGED })),
    ])
    const result = await run({ stack: 5 })
    expect(result).toMatchObject({ stack_number: 5, removed: [102, 103], changed: true })
    expect(result.remaining).toEqual(expectedStack(5, [101], { full: true, pulls: { 101: { state: "merged" } } }))
  })

  test("a stack of merged pull requests only has nothing to remove: changed is false", async () => {
    use([
      repositoryRule(),
      stackRule(5, rawFullStack(5, [101, 102], { 101: MERGED, 102: MERGED })),
      unstackRule(5, rawFullStack(5, [101, 102], { 101: MERGED, 102: MERGED })),
    ])
    expect(await run({ stack: 5 })).toMatchObject({ removed: [], changed: false })
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), stackRule(5, rawFullStack(5, [101, 102])), unstackRule(5)])
    expect((await run({ stack: 5 })).foreign).toBe(true)
  })

  test("a pull request URL names its own repository", async () => {
    const installed = use([
      repositoryRule({ repo: "other/thing" }),
      { match: "repos/other/thing/pulls/7$", stdout: JSON.stringify({ stack: null }) },
    ])
    expect(await run({ pr: "https://github.com/other/thing/pull/7" })).toMatchObject({
      repo: "other/thing",
      changed: false,
    })
    expect(stackPosts(installed)).toEqual([])
  })
})

describe("nothing to take apart", () => {
  test("a pull request in no stack: no write, and nothing is read but the pull request", async () => {
    const installed = use([repositoryRule(), pullRule(41, null)])
    expect(await run({ pr: "41" })).toEqual({
      repo: "octo/hello",
      stack_number: null,
      removed: [],
      remaining: null,
      changed: false,
      foreign: false,
    })
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/pulls/41"])
  })

  test("a stack that does not exist is not_found, and nothing is written", async () => {
    const installed = use([repositoryRule(), stackFailureRule("stacks/9$", "Not Found (HTTP 404)")])
    const error = await failure(run({ stack: 9 }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Stack #9 was not found in octo/hello.")
    expect(stackPosts(installed)).toEqual([])
  })
})

describe("refusals", () => {
  test.each([
    ["neither", {}],
    ["blank pr", { pr: " " }],
    ["both", { stack: 5, pr: "7" }],
  ])("%s of stack and pr is invalid_argument, and nothing is sent", async (_, args) => {
    const installed = use([repositoryRule()])
    const error = await failure(run(args))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("exactly one of `stack`")
    expect(installed.calls().filter((call) => call[0] !== "--version")).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is read or written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), stackRule(5, rawFullStack(5, [101, 102]))])
    expect((await failure(run({ stack: 5 }))).code).toBe("forbidden")
    expect(apiPaths(installed)).toEqual([])
  })

  test("a collision with another change is stale", async () => {
    use([
      repositoryRule(),
      stackRule(5, rawFullStack(5, [101, 102])),
      stackFailureRule("stacks/5/unstack", "Conflict (HTTP 409)"),
    ])
    const error = await failure(run({ stack: 5 }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe("Another change to stack #5 is running; read it again and retry.")
  })

  test("an issue URL is invalid_argument", async () => {
    use([repositoryRule()])
    expect((await failure(run({ pr: "https://github.com/octo/hello/issues/7" }))).code).toBe("invalid_argument")
  })
})
