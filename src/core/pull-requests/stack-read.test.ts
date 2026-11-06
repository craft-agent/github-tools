import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  apiPaths,
  expectedStack,
  inStack,
  pullRule,
  rawFullStack,
  rawStack,
  stackFailureRule,
  stackPageRule,
  stackRule,
} from "../../testing/stack-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { stackRead } from "./stack-read"

const { use, run } = writeHarness(stackRead)

describe("view", () => {
  test("by stack number reads that stack in full", async () => {
    const installed = use([stackRule(5, rawFullStack(5, [101, 102, 103]))])
    expect(await run({ method: "view", stack: 5 })).toEqual({
      repo: "octo/hello",
      stack: expectedStack(5, [101, 102, 103]),
    })
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/stacks/5"])
  })

  test("by pull request finds the stack through the pull request", async () => {
    const installed = use([pullRule(102, 101, inStack(5, 2, 3)), stackRule(5, rawFullStack(5, [101, 102, 103]))])
    const result = await run({ method: "view", pr: "#102" })
    expect(result.stack).toEqual(expectedStack(5, [101, 102, 103]))
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/pulls/102", "repos/octo/hello/stacks/5"])
  })

  test("a pull request in no stack gives stack null, not an error", async () => {
    const installed = use([pullRule(41, null)])
    expect(await run({ method: "view", pr: "41" })).toEqual({ repo: "octo/hello", stack: null })
    expect(apiPaths(installed)).toEqual(["repos/octo/hello/pulls/41"])
  })

  test("a pull request URL names its own repository", async () => {
    use([{ match: "repos/other/thing/pulls/7$", stdout: JSON.stringify({ stack: null }) }])
    expect(await run({ method: "view", pr: "https://github.com/other/thing/pull/7" })).toEqual({
      repo: "other/thing",
      stack: null,
    })
  })

  test("a stack that does not exist is not_found", async () => {
    use([stackFailureRule("stacks/9$", "Not Found (HTTP 404)")])
    const error = await failure(run({ method: "view", stack: 9 }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Stack #9 was not found in octo/hello.")
  })

  test("a pull request that does not exist is not_found", async () => {
    use([stackFailureRule("pulls/9$", "Not Found (HTTP 404)")])
    expect((await failure(run({ method: "view", pr: "9" }))).code).toBe("not_found")
  })

  test("an issue URL is invalid_argument, and nothing is read", async () => {
    const installed = use([])
    const error = await failure(run({ method: "view", pr: "https://github.com/octo/hello/issues/7" }))
    expect(error.code).toBe("invalid_argument")
    expect(apiPaths(installed)).toEqual([])
  })

  test.each([
    ["neither", {}],
    ["blank pr", { pr: "  " }],
    ["both", { stack: 5, pr: "7" }],
  ])("%s of stack and pr is invalid_argument", async (_, extra) => {
    const installed = use([])
    const error = await failure(run({ method: "view", ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("exactly one of `stack`")
    expect(apiPaths(installed)).toEqual([])
  })
})

describe("list", () => {
  test("rows give the numbers bottom to top, and open stacks are the default", async () => {
    use([stackPageRule(1, [rawStack(5, [101, 102]), rawStack(6, [103, 104, 105], {}, { open: false })])])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      stacks: [{ number: 5, base: "main", open: true, size: 2, prs: [101, 102] }],
      truncated: false,
    })
  })

  test("state all keeps the closed stacks too", async () => {
    use([stackPageRule(1, [rawStack(5, [101, 102]), rawStack(6, [103, 104, 105], {}, { open: false })])])
    const result = await run({ method: "list", state: "all" })
    expect(result.stacks?.map((row) => [row.number, row.open, row.size])).toEqual([
      [5, true, 2],
      [6, false, 3],
    ])
  })

  test("limit cuts the rows and truncated says more matched", async () => {
    use([stackPageRule(1, [rawStack(1, [11, 12]), rawStack(2, [13, 14]), rawStack(3, [15, 16])])])
    const result = await run({ method: "list", limit: 2 })
    expect(result.stacks?.map((row) => row.number)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
  })

  test("a repository with no stacks lists none", async () => {
    use([stackPageRule(1, [])])
    expect(await run({ method: "list" })).toEqual({ repo: "octo/hello", stacks: [], truncated: false })
  })

  test("repo names another repository", async () => {
    const installed = use([{ match: "repos/other/thing/stacks\\?", stdout: "[]" }])
    expect((await run({ method: "list", repo: "other/thing" })).repo).toBe("other/thing")
    expect(apiPaths(installed)[0]).toStartWith("repos/other/thing/stacks?")
  })

  test.each([0, 101, 1.5])("invalid limit %p", async (limit) => {
    expect((await failure(run({ method: "list", limit }))).code).toBe("invalid_argument")
  })
})

describe("argument refusals", () => {
  test.each([
    ["stack", 5],
    ["pr", "7"],
  ])("list refuses %s", async (name, value) => {
    const error = await failure(run({ method: "list", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(`"${name}" is an argument of method "view", not "list"; leave it out.`)
  })

  test.each([
    ["state", "open"],
    ["limit", 5],
  ])("view refuses %s", async (name, value) => {
    const error = await failure(run({ method: "view", stack: 5, [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(`"${name}" is an argument of method "list", not "view"; leave it out.`)
  })
})
