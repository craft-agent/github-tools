import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors, gqlReply } from "../../testing/gql"
import { isToolError, type ErrorCode } from "../errors"
import { parseRepo } from "../refs"
import { assertWritable, issueTypes, repositoryContext, resetIssueTypeCache } from "./repository"

const CTX = { cwd: process.cwd() }
const REPO = parseRepo("octo/hello")

let fake: FakeGh | undefined

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

beforeEach(resetIssueTypeCache)

afterEach(() => {
  fake?.restore()
  fake = undefined
})

function repositoryReply(options: { owner?: string; ownerType?: string; permission?: string | null; viewer?: string }) {
  return {
    match: "viewerPermission",
    stdout: gqlReply({
      viewer: { login: options.viewer ?? "me" },
      repository: {
        id: "R_1",
        nameWithOwner: `${options.owner ?? "octo"}/hello`,
        viewerPermission: options.permission === undefined ? "WRITE" : options.permission,
        owner: { __typename: options.ownerType ?? "Organization", login: options.owner ?? "octo" },
      },
    }),
  } satisfies GhRule
}

const membership = (member: boolean | null): GhRule => ({
  match: "viewerIsAMember",
  stdout: gqlReply({ organization: member === null ? null : { viewerIsAMember: member } }),
})

async function codeOf(promise: Promise<unknown>): Promise<ErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!isToolError(error)) throw new Error(`expected a ToolError, got ${String(error)}`)
  return error.code
}

describe("repositoryContext", () => {
  test("reads the repository, its owner type, the viewer and the permission in one query", async () => {
    const installed = useFake([
      repositoryReply({ owner: "octo", viewer: "octo", ownerType: "User", permission: "ADMIN" }),
    ])
    expect(await repositoryContext(REPO, CTX)).toEqual({
      repo: { owner: "octo", name: "hello", full: "octo/hello" },
      id: "R_1",
      owner_type: "User",
      viewer: "octo",
      permission: "ADMIN",
      foreign: false,
    })
    const calls = installed.calls().filter((args) => args[0] === "api")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("owner=octo")
    expect(calls[0]).toContain("name=hello")
  })

  test("takes the repository's name from GitHub's spelling", async () => {
    useFake([repositoryReply({ owner: "Octo", ownerType: "User", viewer: "Octo" })])
    expect((await repositoryContext(parseRepo("octo/hello"), CTX)).repo.full).toBe("Octo/hello")
  })

  test("a repository of another user is foreign", async () => {
    useFake([repositoryReply({ owner: "octo", ownerType: "User", viewer: "me" })])
    const context = await repositoryContext(REPO, CTX)
    expect(context.owner_type).toBe("User")
    expect(context.foreign).toBe(true)
  })

  test("the viewer's own repository is not foreign, whatever the case of the login", async () => {
    useFake([repositoryReply({ owner: "Octo", ownerType: "User", viewer: "octo" })])
    expect((await repositoryContext(REPO, CTX)).foreign).toBe(false)
  })

  test("an organization repository is not foreign to a member", async () => {
    const installed = useFake([repositoryReply({ ownerType: "Organization" }), membership(true)])
    const context = await repositoryContext(REPO, CTX)
    expect(context.owner_type).toBe("Organization")
    expect(context.foreign).toBe(false)
    expect(installed.calls().filter((args) => args[0] === "api")).toHaveLength(2)
  })

  test("an organization repository is foreign to a non-member", async () => {
    useFake([repositoryReply({ ownerType: "Organization" }), membership(false)])
    expect((await repositoryContext(REPO, CTX)).foreign).toBe(true)
  })

  test("a membership read that fails counts as not a member", async () => {
    useFake([
      repositoryReply({ ownerType: "Organization" }),
      { match: "viewerIsAMember", stdout: gqlErrors([{ type: "FORBIDDEN", message: "no" }]) },
    ])
    expect((await repositoryContext(REPO, CTX)).foreign).toBe(true)
  })

  test("a user's repository asks nothing about membership", async () => {
    const installed = useFake([repositoryReply({ ownerType: "User" })])
    await repositoryContext(REPO, CTX)
    expect(installed.calls().filter((args) => args.join(" ").includes("viewerIsAMember"))).toHaveLength(0)
  })

  test("a permission GitHub does not report is null", async () => {
    useFake([repositoryReply({ ownerType: "User", permission: null })])
    expect((await repositoryContext(REPO, CTX)).permission).toBeNull()
  })

  test("a missing repository is not_found, whether GitHub says so with an error or with null", async () => {
    useFake([
      {
        match: "viewerPermission",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve" }], { repository: null }),
      },
    ])
    expect(await codeOf(repositoryContext(REPO, CTX))).toBe("not_found")
    fake?.restore()
    useFake([{ match: "viewerPermission", stdout: gqlReply({ viewer: { login: "me" }, repository: null }) }])
    expect(await codeOf(repositoryContext(REPO, CTX))).toBe("not_found")
  })

  test("other failures keep their code", async () => {
    useFake([{ match: "viewerPermission", stdout: gqlErrors([{ type: "RATE_LIMITED", message: "slow down" }]) }])
    expect(await codeOf(repositoryContext(REPO, CTX))).toBe("rate_limited")
  })
})

describe("assertWritable", () => {
  const contextWith = async (permission: string | null) => {
    useFake([repositoryReply({ ownerType: "User", permission })])
    const context = await repositoryContext(REPO, CTX)
    fake?.restore()
    return context
  }

  test.each(["ADMIN", "MAINTAIN", "WRITE"])("%s may write", async (permission) => {
    const context = await contextWith(permission)
    expect(() => assertWritable(context)).not.toThrow()
  })

  test.each(["TRIAGE", "READ", null])("%p may not write: forbidden, naming the repository", async (permission) => {
    const context = await contextWith(permission)
    let error: unknown
    try {
      assertWritable(context)
    } catch (e) {
      error = e
    }
    expect(isToolError(error) && error.code).toBe("forbidden")
    expect((error as Error).message).toContain("octo/hello")
    expect((error as Error).message).toContain(permission ?? "none")
  })
})

describe("issueTypes", () => {
  const ISSUE_TYPES = "issueTypes\\(first"
  const typesReply = (names: { name: string; isEnabled: boolean }[]): GhRule => ({
    match: ISSUE_TYPES,
    stdout: gqlReply({ repositoryOwner: { __typename: "Organization", issueTypes: { nodes: names } } }),
  })
  const apiCalls = (installed: FakeGh) => installed.calls().filter((args) => args[0] === "api")

  test("an organization's enabled Issue Types, by name, from one read of the owner", async () => {
    const installed = useFake([
      typesReply([
        { name: "Bug", isEnabled: true },
        { name: "Epic", isEnabled: false },
        { name: "Feature", isEnabled: true },
      ]),
    ])
    expect(await issueTypes(REPO, CTX)).toEqual(["Bug", "Feature"])
    expect(apiCalls(installed)).toHaveLength(1)
    expect(apiCalls(installed)[0]).toContain("login=octo")
  })

  test("a user has none, and that is cached too", async () => {
    const installed = useFake([{ match: ISSUE_TYPES, stdout: gqlReply({ repositoryOwner: { __typename: "User" } }) }])
    expect(await issueTypes(REPO, CTX)).toEqual([])
    expect(await issueTypes(REPO, CTX)).toEqual([])
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("is cached per owner for the process", async () => {
    const installed = useFake([typesReply([{ name: "Bug", isEnabled: true }])])
    await issueTypes(REPO, CTX)
    await issueTypes(parseRepo("OCTO/other"), CTX)
    expect(apiCalls(installed)).toHaveLength(1)
    await issueTypes(parseRepo("elsewhere/hello"), CTX)
    expect(apiCalls(installed)).toHaveLength(2)
  })

  test.each([
    ["forbidden", { type: "FORBIDDEN", message: "octo does not have permission to retrieve issueType information." }],
    ["not_found", { type: "NOT_FOUND", message: "Could not resolve to a RepositoryOwner" }],
  ])("a %s read is empty and not cached, so a later call retries", async (_code, entry) => {
    useFake([
      { match: ISSUE_TYPES, stdout: gqlErrors([entry]), times: 1 },
      typesReply([{ name: "Bug", isEnabled: true }]),
    ])
    expect(await issueTypes(REPO, CTX)).toEqual([])
    expect(await issueTypes(REPO, CTX)).toEqual(["Bug"])
  })

  test("an owner GitHub does not know is empty", async () => {
    useFake([{ match: ISSUE_TYPES, stdout: gqlReply({ repositoryOwner: null }) }])
    expect(await issueTypes(REPO, CTX)).toEqual([])
  })

  test.each([
    ["rate_limited", { type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    ["unauthenticated", { message: "HTTP 401: Bad credentials" }],
  ])("a %s read is thrown, not read as no Issue Types", async (code, entry) => {
    useFake([{ match: ISSUE_TYPES, stdout: gqlErrors([entry]) }])
    expect(await codeOf(issueTypes(REPO, CTX))).toBe(code as ErrorCode)
  })
})
