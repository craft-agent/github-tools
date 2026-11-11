import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  addRule,
  chainRules,
  createRule,
  expectedStack,
  inStack,
  pullRule,
  rawFullStack,
  stackFailureRule,
  stackPosts,
  stackRule,
} from "../../testing/stack-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import type { ErrorCode } from "../errors"
import { stackLink } from "./stack-link"

const { use, run } = writeHarness(stackLink)

const CREATE = "repos/octo/hello/stacks"
const ADD = "repos/octo/hello/stacks/5/add"

/** Pull requests 101..103 of stack 5, bottom to top, as `GET pulls/<n>` reports them. */
const inFive = (numbers: readonly number[], size = numbers.length) =>
  Object.fromEntries(numbers.map((number, index) => [number, inStack(5, index + 1, size)]))

describe("making a stack", () => {
  test("pull requests in no stack are posted bottom to top, and GitHub's stack comes back", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([101, 102, 103]),
      createRule(rawFullStack(5, [101, 102, 103])),
    ])
    expect(await run({ prs: [101, 102, 103] })).toEqual({
      repo: "octo/hello",
      stack: expectedStack(5, [101, 102, 103]),
      changed: true,
      created: true,
      added: [101, 102, 103],
      foreign: false,
    })
    expect(stackPosts(installed)).toEqual([{ path: CREATE, body: { pull_requests: [101, 102, 103] } }])
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), ...chainRules([101, 102]), createRule(rawFullStack(5, [101, 102]))])
    expect((await run({ prs: [101, 102] })).foreign).toBe(true)
  })

  test("repo names the repository the pull requests are read in", async () => {
    const installed = use([
      repositoryRule({ repo: "other/thing" }),
      { match: "repos/other/thing/pulls/1$", stdout: JSON.stringify(pullBody(1, null, "other/thing")) },
      { match: "repos/other/thing/pulls/2$", stdout: JSON.stringify(pullBody(2, 1, "other/thing")) },
      { match: "repos/other/thing/stacks --input", stdout: JSON.stringify(rawFullStack(5, [1, 2])) },
    ])
    expect((await run({ prs: [1, 2], repo: "other/thing" })).repo).toBe("other/thing")
    expect(stackPosts(installed)[0]!.path).toBe("repos/other/thing/stacks")
  })

  test("one pull request in no stack cannot make one", async () => {
    const installed = use([repositoryRule(), ...chainRules([101])])
    const error = await failure(run({ prs: [101] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("at least 2")
    expect(stackPosts(installed)).toEqual([])
  })
})

describe("growing a stack", () => {
  test("listing the whole stack and the new pull request adds only the new one", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([101, 102, 103], inFive([101, 102], 2)),
      stackRule(5, rawFullStack(5, [101, 102])),
      addRule(5, rawFullStack(5, [101, 102, 103])),
    ])
    expect(await run({ prs: [101, 102, 103] })).toEqual({
      repo: "octo/hello",
      stack: expectedStack(5, [101, 102, 103]),
      changed: true,
      created: false,
      added: [103],
      foreign: false,
    })
    expect(stackPosts(installed)).toEqual([{ path: ADD, body: { pull_requests: [103] } }])
  })

  test("listing only the top of the stack with the new ones is enough", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([102, 103, 104], inFive([102], 2)),
      stackRule(5, rawFullStack(5, [101, 102])),
      addRule(5, rawFullStack(5, [101, 102, 103, 104])),
    ])
    const result = await run({ prs: [102, 103, 104] })
    expect(result).toMatchObject({ changed: true, created: false, added: [103, 104] })
    expect(result.stack.size).toBe(4)
    expect(stackPosts(installed)).toEqual([{ path: ADD, body: { pull_requests: [103, 104] } }])
  })

  test("any tail of the stack may be listed", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([102, 103, 104], inFive([102, 103], 3)),
      stackRule(5, rawFullStack(5, [101, 102, 103])),
      addRule(5, rawFullStack(5, [101, 102, 103, 104])),
    ])
    expect(await run({ prs: [102, 103, 104] })).toMatchObject({ added: [104] })
    expect(stackPosts(installed)[0]!.body).toEqual({ pull_requests: [104] })
  })

  test("pull requests that are in the stack already change nothing: no write", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([101, 102], inFive([101, 102])),
      stackRule(5, rawFullStack(5, [101, 102])),
    ])
    expect(await run({ prs: [101, 102] })).toEqual({
      repo: "octo/hello",
      stack: expectedStack(5, [101, 102]),
      changed: false,
      created: false,
      added: [],
      foreign: false,
    })
    expect(stackPosts(installed)).toEqual([])
  })

  test("the top of a longer stack alone changes nothing either", async () => {
    const installed = use([
      repositoryRule(),
      ...chainRules([103], inFive([103], 3)),
      stackRule(5, rawFullStack(5, [101, 102, 103])),
    ])
    expect(await run({ prs: [103] })).toMatchObject({ changed: false, added: [] })
    expect(stackPosts(installed)).toEqual([])
  })
})

describe("refusals before any write", () => {
  const refused = async (
    rules: Parameters<typeof use>[0],
    prs: number[],
    code: ErrorCode = "invalid_argument",
    options: { messageHas?: string[] } = {},
  ) => {
    const installed = use([repositoryRule(), ...rules])
    const error = await failure(run({ prs }))
    expect(error.code).toBe(code)
    for (const text of options.messageHas ?? []) expect(error.message).toContain(text)
    expect(stackPosts(installed)).toEqual([])
    return error
  }

  test("a repeated number", async () => {
    const error = await refused([], [101, 102, 101])
    expect(error.message).toBe("#101 is listed twice; list each pull request once.")
  })

  test.each([
    ["merged", { state: "closed", merged_at: "2026-11-02T00:00:00Z" }],
    ["closed", { state: "closed" }],
  ])("a %s pull request", async (word, extra) => {
    await refused(chainRules([101, 102], { 102: extra }), [101, 102], "invalid_argument", {
      messageHas: [`octo/hello#102 is ${word}`],
    })
  })

  test("a pull request whose head is in another repository", async () => {
    const head = { ref: "feature-102", sha: "sha-102", repo: { full_name: "alice/hello" } }
    await refused(chainRules([101, 102], { 102: { head } }), [101, 102], "invalid_argument", {
      messageHas: ["#102's head branch is in alice/hello", "stacks join pull requests of one repository"],
    })
  })

  test("a pull request whose fork is deleted", async () => {
    const head = { ref: "feature-102", sha: "sha-102", repo: null }
    await refused(chainRules([101, 102], { 102: { head } }), [101, 102], "invalid_argument", {
      messageHas: ["a fork that no longer exists", "stacks join pull requests of one repository"],
    })
  })

  test("bases that do not chain name the base to fix", async () => {
    const error = await refused([pullRule(101, null), pullRule(102, null)], [101, 102])
    expect(error.message).toBe(
      "#102's base is main, not feature-101 (the head of #101 below it); change it with github_pr_edit base, then link again.",
    )
  })

  test("pull requests of two stacks", async () => {
    const error = await refused(
      chainRules([101, 102], { 101: inStack(5, 1, 1), 102: inStack(6, 1, 1) }),
      [101, 102],
      "invalid_argument",
      { messageHas: ["#101 is in stack #5", "#102 is in stack #6"] },
    )
    expect(error.message).toContain("github_stack_unlink")
  })

  test.each([
    ["a new pull request below the stack", [104, 103], [103]],
    ["a gap: the run does not end at the top", [101, 102, 104], [101, 102]],
    ["a different order", [102, 101, 104], [101, 102]],
    ["a pull request of the stack after the new ones", [103, 104, 102], [102, 103]],
  ])("%s", async (_, prs, inStackNumbers) => {
    const extra = inFive(inStackNumbers, 3)
    await refused(
      [...chainRules(prs, extra), stackRule(5, rawFullStack(5, [101, 102, 103]))],
      prs,
      "invalid_argument",
      { messageHas: ["go on top of #103", "Stack #5 is, bottom to top: #101, #102, #103."] },
    )
  })

  test("a pull request that does not exist is not_found; the first one listed decides", async () => {
    const installed = use([
      repositoryRule(),
      stackFailureRule("pulls/101$", "Not Found (HTTP 404)"),
      stackFailureRule("pulls/102$", "Not Found (HTTP 404)"),
    ])
    const error = await failure(run({ prs: [101, 102] }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#101")
    expect(stackPosts(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is read", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), ...chainRules([101, 102])])
    expect((await failure(run({ prs: [101, 102] }))).code).toBe("forbidden")
    expect(installed.calls().filter((args) => args.some((arg) => arg.startsWith("repos/")))).toEqual([])
  })

  test.each([[[]], [[0]], [[1.5]], [Array.from({ length: 101 }, (_, i) => i + 1)]])("invalid prs %p", async (prs) => {
    expect((await failure(run({ prs }))).code).toBe("invalid_argument")
  })
})

describe("GitHub refuses the write", () => {
  test("a collision with another change is stale", async () => {
    use([
      repositoryRule(),
      ...chainRules([101, 102, 103], inFive([101, 102], 2)),
      stackRule(5, rawFullStack(5, [101, 102])),
      stackFailureRule("stacks/5/add", "Conflict (HTTP 409)"),
    ])
    const error = await failure(run({ prs: [101, 102, 103] }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe("Another change to stack #5 is running; read it again and retry.")
  })

  test("a 422 keeps GitHub's errors", async () => {
    use([
      repositoryRule(),
      ...chainRules([101, 102]),
      stackFailureRule("repos/octo/hello/stacks --input", "Unprocessable Entity (HTTP 422)", {
        message: "Unprocessable Entity",
        errors: ["pull request #102 is a draft"],
      }),
    ])
    const error = await failure(run({ prs: [101, 102] }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("Unprocessable Entity (HTTP 422)")
    expect(error.message).toContain("pull request #102 is a draft")
  })
})

/** The reply of `GET pulls/<n>` for a pull request of `repo` based on the head of `below`. */
function pullBody(number: number, below: number | null, repo: string) {
  return {
    state: "open",
    draft: false,
    merged_at: null,
    base: { ref: below === null ? "main" : `feature-${below}` },
    head: { ref: `feature-${number}`, sha: `sha-${number}`, repo: { full_name: repo } },
    stack: null,
  }
}
