import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import {
  apiPaths,
  createRule,
  expectedStack,
  inStack,
  pullRule,
  rawFullStack,
  rawStack,
  stackFailureRule,
  stackPageRule,
  stackPosts,
  stackRule,
  unstackRule,
} from "../../testing/stack-fixtures"
import { parseRepo } from "../refs"
import {
  STACK_API_VERSION,
  addToStack,
  createStack,
  listStacks,
  readPullForStack,
  readStack,
  stackOfPull,
  unstack,
} from "./stacks"

const CTX = { cwd: process.cwd() }
const REPO = parseRepo("octo/hello")
const VERSION_HEADER = ["-H", `X-GitHub-Api-Version: ${STACK_API_VERSION}`]

let fake: FakeGh | undefined

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

afterEach(() => {
  fake?.restore()
  fake = undefined
})

/** Every `gh api` call that went to the REST API. */
const restCalls = (installed: FakeGh): string[][] =>
  installed.calls().filter((args) => args[0] === "api" && args.some((arg) => arg.startsWith("repos/")))

describe("the stack shape", () => {
  test("a full stack keeps every field of its pull requests", async () => {
    useFake([stackRule(5, rawFullStack(5, [101, 102, 103]))])
    expect(await readStack(REPO, 5, CTX)).toEqual(expectedStack(5, [101, 102, 103]))
  })

  test("the short form of a list has no title, base or url on its pull requests", async () => {
    useFake([stackPageRule(1, [rawStack(5, [101, 102])])])
    expect(await listStacks(REPO, { openOnly: false, limit: 30 }, CTX)).toEqual({
      stacks: [expectedStack(5, [101, 102], { full: false })],
      truncated: false,
    })
  })

  test("merged_at makes a closed pull request merged; draft and closed are kept", async () => {
    useFake([
      stackRule(
        5,
        rawFullStack(5, [101, 102, 103], {
          101: { state: "closed", merged_at: "2026-11-02T00:00:00Z" },
          102: { state: "closed" },
          103: { draft: true },
        }),
      ),
    ])
    const stack = await readStack(REPO, 5, CTX)
    expect(stack.layers.map((layer) => [layer.position, layer.state, layer.draft])).toEqual([
      [1, "merged", false],
      [2, "closed", false],
      [3, "open", true],
    ])
  })
})

describe("the API version", () => {
  test("every call sends the version header", async () => {
    const installed = useFake([
      stackRule(5, rawFullStack(5, [101, 102])),
      stackPageRule(1, []),
      pullRule(101, null),
      createRule(rawFullStack(5, [101, 102])),
      unstackRule(5),
    ])
    await readStack(REPO, 5, CTX)
    await listStacks(REPO, { openOnly: true, limit: 5 }, CTX)
    await stackOfPull(REPO, 101, CTX)
    await readPullForStack(REPO, 101, CTX)
    await createStack(REPO, [101, 102], CTX)
    await unstack(REPO, 5, CTX)
    const calls = restCalls(installed)
    expect(calls).toHaveLength(6)
    for (const args of calls) {
      const at = args.indexOf("-H")
      expect(args.slice(at, at + 2)).toEqual(VERSION_HEADER)
    }
  })
})

describe("listing", () => {
  test("only open stacks are kept on request", async () => {
    useFake([stackPageRule(1, [rawStack(5, [101, 102]), rawStack(6, [103, 104], {}, { open: false })])])
    const open = await listStacks(REPO, { openOnly: true, limit: 30 }, CTX)
    expect(open.stacks.map((stack) => stack.number)).toEqual([5])
    const all = await listStacks(REPO, { openOnly: false, limit: 30 }, CTX)
    expect(all.stacks.map((stack) => stack.number)).toEqual([5, 6])
  })

  test("a full page leads to the next, and a short page ends the walk", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawStack(i + 1, [1000 + i, 2000 + i]))
    const installed = useFake([stackPageRule(1, full), stackPageRule(2, [])])
    const result = await listStacks(REPO, { openOnly: true, limit: 100 }, CTX)
    expect(result.stacks).toHaveLength(100)
    expect(result.truncated).toBe(false)
    expect(apiPaths(installed)).toHaveLength(2)
  })

  test("a match on the next page past the limit truncates", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawStack(i + 1, [1000 + i, 2000 + i]))
    useFake([stackPageRule(1, full), stackPageRule(2, [rawStack(101, [3001, 3002])])])
    const result = await listStacks(REPO, { openOnly: true, limit: 100 }, CTX)
    expect(result.stacks).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  test("more matches than the limit stop the walk and truncate", async () => {
    const installed = useFake([stackPageRule(1, [rawStack(1, [11, 12]), rawStack(2, [13, 14]), rawStack(3, [15, 16])])])
    const result = await listStacks(REPO, { openOnly: true, limit: 2 }, CTX)
    expect(result.stacks.map((stack) => stack.number)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
    expect(apiPaths(installed)).toHaveLength(1)
  })

  test("exactly the limit is not truncated when the page is short", async () => {
    useFake([stackPageRule(1, [rawStack(1, [11, 12]), rawStack(2, [13, 14])])])
    expect((await listStacks(REPO, { openOnly: true, limit: 2 }, CTX)).truncated).toBe(false)
  })

  test("the walk stops at ten pages and says it was cut short", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawStack(i + 1, [1000 + i, 2000 + i], {}, { open: false }))
    const installed = useFake([{ match: "stacks\\?per_page=100&page=\\d+$", stdout: JSON.stringify(full) }])
    const result = await listStacks(REPO, { openOnly: true, limit: 30 }, CTX)
    expect(result).toEqual({ stacks: [], truncated: true })
    expect(apiPaths(installed)).toHaveLength(10)
  })
})

describe("pull requests", () => {
  test("the stack of a pull request is its number, or null", async () => {
    useFake([pullRule(101, null, inStack(5, 1, 2)), pullRule(103, null)])
    expect(await stackOfPull(REPO, 101, CTX)).toBe(5)
    expect(await stackOfPull(REPO, 103, CTX)).toBeNull()
  })

  test("a pull request is read with its state word, branches and place", async () => {
    useFake([
      pullRule(101, null, { ...inStack(5, 2, 3), state: "closed", merged_at: "2026-11-02T00:00:00Z", draft: true }),
      pullRule(102, 101, { head: { ref: "feature-102", sha: "sha-102", repo: null } }),
    ])
    expect(await readPullForStack(REPO, 101, CTX)).toEqual({
      number: 101,
      state: "merged",
      draft: true,
      base: "main",
      head: "feature-101",
      head_sha: "sha-101",
      head_repo: "octo/hello",
      stack: 5,
      position: 2,
    })
    expect(await readPullForStack(REPO, 102, CTX)).toMatchObject({
      base: "feature-101",
      head_repo: null,
      stack: null,
      position: null,
    })
  })

  test("a pull request that does not exist is not_found", async () => {
    useFake([stackFailureRule("pulls/9$", "Not Found (HTTP 404)")])
    const error = await failure(readPullForStack(REPO, 9, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#9")
  })
})

describe("writes", () => {
  test("create sends the numbers bottom to top and returns GitHub's stack", async () => {
    const installed = useFake([createRule(rawFullStack(5, [101, 102]))])
    expect(await createStack(REPO, [101, 102], CTX)).toEqual(expectedStack(5, [101, 102]))
    expect(stackPosts(installed)).toEqual([{ path: "repos/octo/hello/stacks", body: { pull_requests: [101, 102] } }])
  })

  test("add sends only the new pull requests to the stack", async () => {
    const installed = useFake([
      { match: "repos/octo/hello/stacks/5/add", stdout: JSON.stringify(rawFullStack(5, [101, 102, 103])) },
    ])
    expect((await addToStack(REPO, 5, [103], CTX)).size).toBe(3)
    expect(stackPosts(installed)).toEqual([{ path: "repos/octo/hello/stacks/5/add", body: { pull_requests: [103] } }])
  })

  test("unstack sends no body and an empty reply means the stack is gone", async () => {
    const installed = useFake([unstackRule(5)])
    expect(await unstack(REPO, 5, CTX)).toBeNull()
    expect(stackPosts(installed)).toEqual([{ path: "repos/octo/hello/stacks/5/unstack", body: null }])
  })

  test("unstack returns the stack that remains", async () => {
    useFake([unstackRule(5, rawFullStack(5, [101], { 101: { state: "closed", merged_at: "2026-11-02T00:00:00Z" } }))])
    const remaining = await unstack(REPO, 5, CTX)
    expect(remaining?.layers.map((layer) => [layer.number, layer.state])).toEqual([[101, "merged"]])
  })
})

describe("failures", () => {
  test("a missing stack is not_found, naming the stack and the repository", async () => {
    useFake([stackFailureRule("stacks/5$", "Not Found (HTTP 404)")])
    const error = await failure(readStack(REPO, 5, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Stack #5 was not found in octo/hello.")
  })

  test("a collision with another change is stale, and says to read again", async () => {
    useFake([stackFailureRule("stacks/5/add", "Conflict (HTTP 409)")])
    const error = await failure(addToStack(REPO, 5, [103], CTX))
    expect(error.code).toBe("stale")
    expect(error.message).toBe("Another change to stack #5 is running; read it again and retry.")
  })

  test("a collision while creating is stale too", async () => {
    useFake([stackFailureRule("repos/octo/hello/stacks --input", "Conflict (HTTP 409)")])
    const error = await failure(createStack(REPO, [101, 102], CTX))
    expect(error.code).toBe("stale")
    expect(error.message).toBe("Another change to a stack is running; read it again and retry.")
  })

  test("other failures keep GitHub's text and the mapping of the runner", async () => {
    useFake([
      stackFailureRule("repos/octo/hello/stacks --input", "Unprocessable Entity (HTTP 422)", {
        message: "Unprocessable Entity",
        errors: ["pull request #102 is already in a stack"],
      }),
    ])
    const error = await failure(createStack(REPO, [101, 102], CTX))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("Unprocessable Entity (HTTP 422)")
    expect(error.message).toContain("pull request #102 is already in a stack")
  })
})
