import { afterEach, describe, expect, test } from "bun:test"
import type { ErrorCode } from "./errors"
import { classifyGhFailure, ghEnv, passthroughEnv } from "./gh"

afterEach(() => {
  delete process.env.GH_REPO
})

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
