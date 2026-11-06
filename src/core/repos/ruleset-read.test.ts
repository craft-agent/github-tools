import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { failure } from "../../testing/issue-fixtures"
import { graphqlCalls, graphqlRule, page, repositoryReply, restFailure, restPaths } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { rulesetRead } from "./ruleset-read"

const { use, run } = writeHarness(rulesetRead)

const LIST = "rulesets\\?includes_parents"
const CLASSIC = "branchProtectionRules"

const rawRow = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Ruleset ${id}`,
  target: "branch",
  source_type: "Repository",
  source: "octo/hello",
  enforcement: "active",
  node_id: `RRS_${id}`,
  _links: { html: { href: `https://github.com/octo/hello/rules/${id}` } },
  created_at: "2026-11-03T12:44:43.508+08:00",
  updated_at: "2026-11-04T14:20:32.084+08:00",
  ...extra,
})

const expectedRow = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Ruleset ${id}`,
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  source: "octo/hello",
  updated_at: "2026-11-04T14:20:32.084+08:00",
  ...extra,
})

const listRule = (...pages: unknown[][]): GhRule => ({ match: LIST, stdout: JSON.stringify(pages) })

const rawClassic = (extra: Record<string, unknown> = {}) => ({
  pattern: "main",
  requiresApprovingReviews: true,
  requiredApprovingReviewCount: 2,
  requiresStatusChecks: true,
  requiredStatusCheckContexts: ["build", "lint"],
  allowsForcePushes: false,
  allowsDeletions: false,
  requiresLinearHistory: true,
  isAdminEnforced: true,
  ...extra,
})

const classicRule = (nodes: unknown[]) => graphqlRule(CLASSIC, { repository: { branchProtectionRules: page(nodes) } })

const rawRuleset = rawRow(7, {
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }],
  bypass_actors: [
    { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
  ],
})

describe("list", () => {
  test("rulesets with inherited ones, and the classic rules mapped", async () => {
    const installed = use([
      listRule([rawRow(1), rawRow(2, { source_type: "Organization", source: "octo", updated_at: undefined })]),
      classicRule([rawClassic()]),
    ])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      rulesets: [expectedRow(1), expectedRow(2, { source_type: "Organization", source: "octo", updated_at: null })],
      classic: [
        {
          pattern: "main",
          required_approvals: 2,
          required_checks: ["build", "lint"],
          allows_force_pushes: false,
          allows_deletions: false,
          linear_history: true,
          enforce_admins: true,
        },
      ],
    })
    expect(restPaths(installed)).toEqual(["repos/octo/hello/rulesets?includes_parents=true&per_page=100"])
    expect(graphqlCalls(installed)[0]!.vars).toEqual({ owner: "octo", name: "hello", after: "null" })
  })

  test("include_parents false is sent, and pages are joined", async () => {
    const installed = use([listRule([rawRow(1)], [rawRow(2)]), classicRule([])])
    const result = await run({ method: "list", include_parents: false })
    expect(result.rulesets?.map((ruleset) => ruleset.id)).toEqual([1, 2])
    expect(result.classic).toEqual([])
    expect(restPaths(installed)).toEqual(["repos/octo/hello/rulesets?includes_parents=false&per_page=100"])
  })

  test("a classic rule that requires nothing reads 0 approvals and no checks", async () => {
    use([
      listRule(),
      classicRule([
        rawClassic({
          requiresApprovingReviews: false,
          requiredApprovingReviewCount: 3,
          requiresStatusChecks: false,
          requiredStatusCheckContexts: ["stale"],
          allowsForcePushes: true,
          allowsDeletions: true,
          requiresLinearHistory: false,
          isAdminEnforced: false,
        }),
      ]),
    ])
    expect((await run({ method: "list" })).classic).toEqual([
      {
        pattern: "main",
        required_approvals: 0,
        required_checks: [],
        allows_force_pushes: true,
        allows_deletions: true,
        linear_history: false,
        enforce_admins: false,
      },
    ])
  })

  test("classic is null when GitHub refuses the read for lack of permission", async () => {
    use([
      listRule([rawRow(1)]),
      {
        match: CLASSIC,
        stdout: gqlErrors([{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }]),
      },
    ])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      rulesets: [expectedRow(1)],
      classic: null,
    })
  })

  test("another failure of the classic read is thrown", async () => {
    use([
      listRule(),
      { match: CLASSIC, stdout: gqlErrors([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]) },
    ])
    expect((await failure(run({ method: "list" }))).code).toBe("rate_limited")
  })

  test("a repository that does not exist is not_found", async () => {
    use([restFailure(LIST, "Not Found (HTTP 404)", { message: "Not Found" })])
    const error = await failure(run({ method: "list", repo: "octo/gone" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Repository octo/gone was not found, or the viewer cannot see it.")
  })

  test("a repository GitHub shows no classic data for is not_found", async () => {
    use([listRule(), { match: CLASSIC, stdout: repositoryReply(null) }])
    expect((await failure(run({ method: "list" }))).code).toBe("not_found")
  })
})

describe("view", () => {
  test("reads one ruleset in full", async () => {
    const installed = use([{ match: "rulesets/7$", stdout: JSON.stringify(rawRuleset) }])
    expect(await run({ method: "view", ruleset: 7 })).toEqual({
      repo: "octo/hello",
      ruleset: {
        ...expectedRow(7),
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [
          { type: "deletion", parameters: null },
          { type: "pull_request", parameters: { required_approving_review_count: 1 } },
        ],
        bypass_actors: [
          { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
          { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
        ],
        created_at: "2026-11-03T12:44:43.508+08:00",
        updated_at: "2026-11-04T14:20:32.084+08:00",
        url: "https://github.com/octo/hello/rules/7",
      },
    })
    expect(restPaths(installed)).toEqual(["repos/octo/hello/rulesets/7"])
    expect(graphqlCalls(installed)).toEqual([])
  })

  test("a numeric string is the id, and what GitHub leaves out reads null", async () => {
    const installed = use([
      {
        match: "other/thing/rulesets/42$",
        stdout: JSON.stringify({
          id: 42,
          name: "Bare",
          target: "push",
          enforcement: "disabled",
          source_type: "Repository",
          source: "other/thing",
        }),
      },
    ])
    const { ruleset } = await run({ method: "view", repo: "other/thing", ruleset: " 42 " })
    expect(ruleset).toEqual({
      id: 42,
      name: "Bare",
      target: "push",
      enforcement: "disabled",
      source_type: "Repository",
      source: "other/thing",
      conditions: null,
      rules: [],
      bypass_actors: null,
      created_at: null,
      updated_at: null,
      url: null,
    })
    expect(restPaths(installed)).toEqual(["repos/other/thing/rulesets/42"])
  })

  test("a ruleset that does not exist is not_found", async () => {
    use([restFailure("rulesets/9$", "Not Found (HTTP 404)", { message: "Not Found" })])
    const error = await failure(run({ method: "view", ruleset: 9 }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Ruleset 9 was not found in octo/hello, or the viewer cannot see it.")
  })

  test("view needs the ruleset, and nothing is read", async () => {
    const installed = use([])
    const error = await failure(run({ method: "view" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("needs `ruleset`")
    expect(restPaths(installed)).toEqual([])
  })

  test.each(["abc", "7x", "-3", "1.5", "", "0", 0, 1.5])("%p is no ruleset id", async (ruleset) => {
    const installed = use([])
    expect((await failure(run({ method: "view", ruleset }))).code).toBe("invalid_argument")
    expect(restPaths(installed)).toEqual([])
  })
})

describe("argument refusals", () => {
  test("list refuses ruleset", async () => {
    const installed = use([])
    const error = await failure(run({ method: "list", ruleset: 7 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"ruleset" is an argument of method "view", not "list"; leave it out.')
    expect(restPaths(installed)).toEqual([])
  })

  test("view refuses include_parents", async () => {
    const error = await failure(run({ method: "view", ruleset: 7, include_parents: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"include_parents" is an argument of method "list", not "view"; leave it out.')
  })
})
