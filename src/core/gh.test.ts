import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installFakeGh, type FakeGh, type GhRule } from "../testing/fake-gh"
import { gqlErrors, gqlReply } from "../testing/gql"
import { isToolError, type ErrorCode } from "./errors"
import {
  DEFAULT_GH_TIMEOUT_MS,
  GraphQLToolError,
  MIN_GH_VERSION,
  classifyGhFailure,
  ensureGh,
  gh,
  ghEnv,
  ghJson,
  graphql,
  lit,
  paginate,
  passthroughEnv,
  resetGhCheck,
} from "./gh"

const ORIGINAL_PATH = process.env.PATH
const OPTIONS = { cwd: process.cwd() }

let fake: FakeGh | undefined
const emptyDirs: string[] = []

function useFake(rules: GhRule[], options?: { version?: string }): FakeGh {
  fake = installFakeGh(rules, options)
  return fake
}

afterEach(() => {
  fake?.restore()
  fake = undefined
  for (const dir of emptyDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  delete process.env.GH_REPO
  resetGhCheck()
})

function emptyPathDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "no-gh-")))
  emptyDirs.push(dir)
  return dir
}

async function codeOf(promise: Promise<unknown>): Promise<ErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!isToolError(error)) throw new Error(`expected a ToolError, got ${String(error)}`)
  return error.code
}

describe("classifyGhFailure", () => {
  const table: [string, ErrorCode][] = [
    ["To get started with GitHub CLI, please run:  gh auth login", "unauthenticated"],
    ["You are not logged into any GitHub hosts", "unauthenticated"],
    ["Authentication required", "unauthenticated"],
    ["gh: Bad credentials (HTTP 401)", "unauthenticated"],
    ["GraphQL: API rate limit exceeded for user ID 1", "rate_limited"],
    ["You have exceeded a secondary rate limit", "rate_limited"],
    ["gh: Too Many Requests (HTTP 429)", "rate_limited"],
    ["gh: Not Found (HTTP 404)", "not_found"],
    ["GraphQL: Could not resolve to an Issue with the number of 99.", "not_found"],
    ["GraphQL: Could not resolve to a Repository with the name 'o/r'.", "not_found"],
    ["GraphQL: Could not resolve something else", "not_found"],
    ["pull request not found", "github_error"],
    ["label not found in the config file", "github_error"],
    ["gh: Forbidden (HTTP 403)", "forbidden"],
    ["GraphQL: Resource not accessible by personal access token", "forbidden"],
    ["GraphQL: You must have push access to the repository to update it; permission denied", "forbidden"],
    ["Your token has not been granted the required scopes: insufficient scopes", "forbidden"],
    ["gh: Conflict (HTTP 409)", "stale"],
    ["Head branch was modified. Review and try the merge again.", "stale"],
    ["Base branch is out of date", "stale"],
    ["Pull request has a merge conflict", "github_error"],
    ["something else broke", "github_error"],
  ]

  test.each(table)("%s -> %s", (stderr, code) => {
    expect(classifyGhFailure(stderr, "", 1).code).toBe(code)
  })

  test("a rate limit reported with HTTP 403 is a rate limit, not a permission problem", () => {
    expect(classifyGhFailure("gh: API rate limit exceeded (HTTP 403)", "", 1).code).toBe("rate_limited")
  })

  test("matches regardless of case", () => {
    expect(classifyGhFailure("HTTP 404: NOT FOUND", "", 1).code).toBe("not_found")
  })

  test("a head ref that was modified is stale, not a conflict", () => {
    expect(classifyGhFailure("Head ref refs/heads/topic was modified", "", 1).code).toBe("stale")
  })

  test("the message is gh's trimmed stderr, or stdout when stderr is empty, with a short prefix", () => {
    expect(classifyGhFailure("  boom\n", "ignored", 4).message).toBe("gh failed (exit 4): boom")
    expect(classifyGhFailure("", "from stdout\n", 1).message).toBe("gh failed (exit 1): from stdout")
    expect(classifyGhFailure("", "", 2).message).toBe("gh failed (exit 2):")
  })

  test("a REST error body on stdout adds its errors to gh's stderr", () => {
    const body = JSON.stringify({
      message: "Unprocessable Entity",
      errors: ["Line could not be resolved", { message: "Another", code: "custom" }, { code: "no message" }],
    })
    expect(classifyGhFailure("gh: Unprocessable Entity (HTTP 422)\n", body, 1).message).toBe(
      "gh failed (exit 1): gh: Unprocessable Entity (HTTP 422): Line could not be resolved; Another",
    )
    expect(classifyGhFailure("gh: boom", "not json", 1).message).toBe("gh failed (exit 1): gh: boom")
    expect(classifyGhFailure("gh: boom", JSON.stringify({ message: "x" }), 1).message).toBe(
      "gh failed (exit 1): gh: boom",
    )
  })

  test("the message is capped, so a huge reply is not echoed whole", () => {
    expect(classifyGhFailure("x".repeat(10_000), "", 1).message.length).toBeLessThan(2100)
  })

  test("an unauthenticated message says what to do", () => {
    expect(classifyGhFailure("Authentication required", "", 1).message).toContain("gh auth login")
  })
})

describe("ghEnv", () => {
  test("passes only the listed variables and forces the non-interactive ones", () => {
    process.env.GH_TOKEN = "token"
    process.env.GH_REPO = "a/b"
    process.env.UNLISTED_VARIABLE = "x"
    process.env.GH_PAGER = "less"
    try {
      const env = ghEnv()
      expect(env.GH_TOKEN).toBe("token")
      expect(env.GH_REPO).toBeUndefined()
      expect(env.UNLISTED_VARIABLE).toBeUndefined()
      expect(env).toMatchObject({
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
        CLICOLOR: "0",
        GH_PAGER: "cat",
      })
    } finally {
      delete process.env.GH_TOKEN
      delete process.env.GH_REPO
      delete process.env.UNLISTED_VARIABLE
      delete process.env.GH_PAGER
    }
  })
})

describe("passthroughEnv", () => {
  const added = [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "SSH_AUTH_SOCK",
    "GIT_SSH_COMMAND",
    "ALL_PROXY",
    "all_proxy",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "PATHEXT",
    "ComSpec",
    "TEMP",
    "TMP",
  ]

  test("passes the keyring, ssh, proxy and Windows variables, and ghEnv builds on it", () => {
    const saved = Object.fromEntries(added.map((name) => [name, process.env[name]]))
    for (const name of added) process.env[name] = `value-of-${name}`
    process.env.GH_REPO = "a/b"
    try {
      const env = passthroughEnv()
      for (const name of added) expect(env[name]).toBe(`value-of-${name}`)
      expect(env.GH_REPO).toBeUndefined()
      expect(env.GH_PROMPT_DISABLED).toBeUndefined()
      expect(ghEnv()).toMatchObject({ ...env, GH_PROMPT_DISABLED: "1" })
    } finally {
      for (const name of added) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  })
})

describe("ensureGh", () => {
  test("gh missing from PATH -> gh_missing", async () => {
    process.env.PATH = emptyPathDir()
    expect(await codeOf(ensureGh())).toBe("gh_missing")
  })

  test("gh older than the minimum -> gh_too_old, naming both versions", async () => {
    useFake([], { version: "2.93.9" })
    const error = await ensureGh().catch((e: unknown) => e)
    expect(isToolError(error) && error.code).toBe("gh_too_old")
    expect((error as Error).message).toContain("2.93.9")
    expect((error as Error).message).toContain(MIN_GH_VERSION)
  })

  test("versions compare numerically, not as text", async () => {
    useFake([], { version: "2.100.0" })
    await ensureGh()
  })

  test("the minimum itself is accepted", async () => {
    useFake([], { version: MIN_GH_VERSION })
    await ensureGh()
  })

  test("an unreadable version answer -> github_error", async () => {
    useFake([{ match: "^--version$", stdout: "hello\n" }])
    expect(await codeOf(ensureGh())).toBe("github_error")
  })

  test("a failed check is not cached: fixing PATH makes the next call pass", async () => {
    const installed = useFake([])
    const withFake = process.env.PATH
    process.env.PATH = emptyPathDir()
    expect(await codeOf(ensureGh())).toBe("gh_missing")
    process.env.PATH = withFake
    await ensureGh()
    expect(installed.calls()).toEqual([["--version"]])
  })

  test("an already aborted signal rejects before anything runs", async () => {
    const installed = useFake([])
    const error = await ensureGh(AbortSignal.abort()).catch((e: unknown) => e)
    expect((error as Error).name).toBe("AbortError")
    expect(installed.calls()).toEqual([])
  })
})

describe("gh", () => {
  test("checks the version once across calls", async () => {
    const installed = useFake([{ match: "^pr list", stdout: "ok" }])
    expect(await gh(["pr", "list"], OPTIONS)).toBe("ok")
    expect(await gh(["pr", "list"], OPTIONS)).toBe("ok")
    expect(installed.calls().filter((call) => call[0] === "--version")).toHaveLength(1)
  })

  test("runs with the forced environment and without GH_REPO", async () => {
    process.env.GH_REPO = "someone/else"
    useFake([])
    const seen = JSON.parse(await gh(["__env"], OPTIONS))
    expect(seen).toEqual({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_REPO: null, GH_PAGER: "cat" })
  })

  test("a non-zero exit throws the classified error", async () => {
    useFake([{ match: "^issue view", stderr: "gh: Not Found (HTTP 404)\n", code: 1 }])
    expect(await codeOf(gh(["issue", "view", "9"], OPTIONS))).toBe("not_found")
  })

  test("a missing gh surfaces as gh_missing", async () => {
    process.env.PATH = emptyPathDir()
    expect(await codeOf(gh(["pr", "list"], OPTIONS))).toBe("gh_missing")
  })

  test("a call over its time limit is stopped and says how long it waited", async () => {
    useFake([{ match: "^slow$", delayMs: 5000 }])
    const error = await gh(["slow"], { ...OPTIONS, timeoutMs: 300 }).catch((e: unknown) => e)
    expect(isToolError(error) && error.code).toBe("github_error")
    expect((error as Error).message).toContain("timed out after 0.3 seconds")
    expect((error as Error).message).toContain("SIGTERM")
  })

  test("the default time limit is two minutes", () => {
    expect(DEFAULT_GH_TIMEOUT_MS).toBe(120_000)
  })

  test("a call that a signal ended is reported with that signal", async () => {
    useFake([{ match: "^doomed$", killSelf: "SIGKILL" }])
    const error = await gh(["doomed"], OPTIONS).catch((e: unknown) => e)
    expect(isToolError(error) && error.code).toBe("github_error")
    expect((error as Error).message).toBe("gh was stopped with SIGKILL.")
  })

  test("aborting a gh call rejects with an AbortError", async () => {
    useFake([{ match: "^slow$", delayMs: 5000 }])
    const controller = new AbortController()
    const pending = gh(["slow"], { ...OPTIONS, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const error = await pending.catch((e: unknown) => e)
    expect((error as Error).name).toBe("AbortError")
  })

  test("ghJson parses stdout and turns empty output into null", async () => {
    useFake([
      { match: "^a$", stdout: '{"n":1}\n' },
      { match: "^b$", stdout: "  \n" },
      { match: "^c$", stdout: "not json" },
    ])
    expect(await ghJson<{ n: number }>(["a"], OPTIONS)).toEqual({ n: 1 })
    expect(await ghJson(["b"], OPTIONS)).toBeNull()
    expect(await codeOf(ghJson(["c"], OPTIONS))).toBe("github_error")
  })
})

describe("graphql", () => {
  test("returns data and sends the query and typed variables as flags", async () => {
    const installed = useFake([{ match: "^api graphql", stdout: gqlReply({ viewer: { login: "me" } }) }])
    const data = await graphql<{ viewer: { login: string } }>(
      "query($s:String,$n:Int,$b:Boolean,$z:String){viewer{login}}",
      { s: "text", n: 12, b: true, z: null, skipped: undefined },
      OPTIONS,
    )
    expect(data).toEqual({ viewer: { login: "me" } })
    const call = installed.calls().find((args) => args[0] === "api")
    expect(call).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query($s:String,$n:Int,$b:Boolean,$z:String){viewer{login}}",
      "-f",
      "s=text",
      "-F",
      "n=12",
      "-F",
      "b=true",
      "-F",
      "z=null",
    ])
  })

  test("a NOT_FOUND error maps to not_found and keeps errors and data", async () => {
    useFake([
      {
        match: "^api graphql",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }], {
          repository: { issue: null },
        }),
        stderr: "gh: Could not resolve to an Issue\n",
        code: 1,
      },
    ])
    const error = await graphql("query{x}", {}, OPTIONS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GraphQLToolError)
    const failure = error as GraphQLToolError
    expect(failure.code).toBe("not_found")
    expect(failure.message).toContain("Could not resolve to an Issue")
    expect(failure.data).toEqual({ repository: { issue: null } })
    expect(failure.graphqlErrors).toEqual([{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }])
  })

  test.each([
    ["FORBIDDEN", "forbidden"],
    ["INSUFFICIENT_SCOPES", "forbidden"],
    ["RATE_LIMITED", "rate_limited"],
  ] as const)("a %s error maps to %s, even when gh exits 0", async (type, code) => {
    useFake([{ match: "^api graphql", stdout: gqlErrors([{ type, message: "nope" }]) }])
    expect(await codeOf(graphql("query{x}", {}, OPTIONS))).toBe(code)
  })

  test("an INSUFFICIENT_SCOPES error says how to grant the scope", async () => {
    useFake([
      { match: "^api graphql", stdout: gqlErrors([{ type: "INSUFFICIENT_SCOPES", message: "needs read:project" }]) },
    ])
    const error = (await graphql("query{x}", {}, OPTIONS).catch((e: unknown) => e)) as GraphQLToolError
    expect(error.message).toContain("needs read:project")
    expect(error.message).toContain("gh auth refresh -s project")
  })

  test("an error without a known type is classified by its message", async () => {
    useFake([{ match: "^api graphql", stdout: gqlErrors([{ type: "OTHER", message: "API rate limit exceeded" }]) }])
    expect(await codeOf(graphql("query{x}", {}, OPTIONS))).toBe("rate_limited")
    fake?.restore()
    useFake([{ match: "^api graphql", stdout: gqlErrors([{ message: "Something odd" }]) }])
    expect(await codeOf(graphql("query{x}", {}, OPTIONS))).toBe("github_error")
  })

  test("an error type named like an object property is not mistaken for a known one", async () => {
    useFake([{ match: "^api graphql", stdout: gqlErrors([{ type: "constructor", message: "odd" }]) }])
    expect(await codeOf(graphql("query{x}", {}, OPTIONS))).toBe("github_error")
  })

  test("a non-zero exit without a GraphQL reply is classified from stderr", async () => {
    useFake([{ match: "^api graphql", stderr: "gh: Bad credentials (HTTP 401)\n", code: 1 }])
    expect(await codeOf(graphql("query{x}", {}, OPTIONS))).toBe("unauthenticated")
  })

  test("a reply that is not JSON, with exit 0, yields null data", async () => {
    useFake([{ match: "^api graphql", stdout: "" }])
    expect(await graphql("query{x}", {}, OPTIONS)).toBeNull()
  })
})

describe("paginate", () => {
  const page = (nodes: number[], next: string | null) =>
    gqlReply({ items: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } })
  const pick = (data: { items: { nodes: number[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }) =>
    data.items

  test("walks pages with the cursor until there is no next page", async () => {
    const installed = useFake([
      { match: "^api graphql", stdout: page([1, 2], "c1"), times: 1 },
      { match: "^api graphql", stdout: page([3], null) },
    ])
    const result = await paginate("query($after:String){items}", { owner: "o" }, pick, OPTIONS)
    expect(result).toEqual({ items: [1, 2, 3], truncated: false })
    const calls = installed.calls().filter((args) => args[0] === "api")
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("after=null")
    expect(calls[1]).toContain("after=c1")
  })

  test("stops at the limit without fetching further pages, and says it truncated", async () => {
    const installed = useFake([{ match: "^api graphql", stdout: page([1, 2, 3], "c1") }])
    const result = await paginate("query{items}", {}, pick, { ...OPTIONS, limit: 2 })
    expect(result).toEqual({ items: [1, 2], truncated: true })
    expect(installed.calls().filter((args) => args[0] === "api")).toHaveLength(1)
  })

  test("a page that ends exactly at the limit is truncated only when more pages follow", async () => {
    useFake([{ match: "^api graphql", stdout: page([1, 2], "c1") }])
    expect(await paginate("query{items}", {}, pick, { ...OPTIONS, limit: 2 })).toEqual({
      items: [1, 2],
      truncated: true,
    })
    fake?.restore()
    useFake([{ match: "^api graphql", stdout: page([1, 2], null) }])
    expect(await paginate("query{items}", {}, pick, { ...OPTIONS, limit: 2 })).toEqual({
      items: [1, 2],
      truncated: false,
    })
  })

  test("a missing connection ends the walk", async () => {
    useFake([{ match: "^api graphql", stdout: gqlReply({ items: null }) }])
    expect(await paginate("query{items}", {}, (data: { items: null }) => data.items, OPTIONS)).toEqual({
      items: [],
      truncated: false,
    })
  })
})

describe("lit", () => {
  test("quotes and escapes a GraphQL string literal", () => {
    expect(lit('say "hi"\n')).toBe('"say \\"hi\\"\\n"')
  })
})
