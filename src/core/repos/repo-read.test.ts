import { describe, expect, test } from "bun:test"
import { gqlErrors } from "../../testing/gql"
import { failure } from "../../testing/issue-fixtures"
import { graphqlCalls, graphqlRule, page, repositoryReply } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { repoRead } from "./repo-read"

const { use, run } = writeHarness(repoRead)

const VIEW = "homepageUrl"
const LIST = "repositories\\("

const rawRepository = (extra: Record<string, unknown> = {}) => ({
  nameWithOwner: "octo/hello",
  url: "https://github.com/octo/hello",
  description: "Says hello",
  homepageUrl: "https://hello.example",
  visibility: "PUBLIC",
  isArchived: false,
  isTemplate: false,
  isFork: false,
  defaultBranchRef: { name: "main" },
  viewerPermission: "ADMIN",
  owner: { __typename: "Organization", login: "octo" },
  hasIssuesEnabled: true,
  hasWikiEnabled: false,
  hasProjectsEnabled: true,
  hasDiscussionsEnabled: false,
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: false,
  autoMergeAllowed: true,
  deleteBranchOnMerge: true,
  allowUpdateBranch: false,
  repositoryTopics: { nodes: [{ topic: { name: "cli" } }, { topic: { name: "git" } }] },
  licenseInfo: { spdxId: "MIT" },
  templateRepository: null,
  parent: null,
  pushedAt: "2026-11-06T16:33:14Z",
  ...extra,
})

const rawRow = (name: string, extra: Record<string, unknown> = {}) => ({
  nameWithOwner: `octo/${name}`,
  url: `https://github.com/octo/${name}`,
  description: `The ${name}`,
  visibility: "PUBLIC",
  isArchived: false,
  isFork: false,
  defaultBranchRef: { name: "main" },
  pushedAt: "2026-11-06T16:33:14Z",
  ...extra,
})

const expectedRow = (name: string, extra: Record<string, unknown> = {}) => ({
  repo: `octo/${name}`,
  url: `https://github.com/octo/${name}`,
  description: `The ${name}`,
  visibility: "public" as const,
  archived: false,
  fork: false,
  default_branch: "main",
  pushed_at: "2026-11-06T16:33:14Z",
  ...extra,
})

describe("view", () => {
  test("maps the repository's settings and facts, and reads the working tree's repository", async () => {
    const installed = use([graphqlRule(VIEW, { repository: rawRepository() })])
    expect(await run({ method: "view" })).toEqual({
      repository: {
        repo: "octo/hello",
        url: "https://github.com/octo/hello",
        description: "Says hello",
        homepage: "https://hello.example",
        visibility: "public",
        archived: false,
        is_template: false,
        fork: null,
        default_branch: "main",
        topics: ["cli", "git"],
        license: "MIT",
        template: null,
        pushed_at: "2026-11-06T16:33:14Z",
        owner_type: "organization",
        permission: "admin",
        features: { issues: true, wiki: false, projects: true, discussions: false },
        merge: {
          merge_commit: true,
          squash: true,
          rebase: false,
          auto_merge: true,
          delete_branch_on_merge: true,
          update_branch: false,
        },
      },
    })
    const [call, ...others] = graphqlCalls(installed)
    expect(others).toEqual([])
    expect(call!.vars).toEqual({ owner: "octo", name: "hello" })
    expect(call!.query).toContain("repositoryTopics(first:20)")
  })

  test("an empty fork of a template owned by a user reads null and empty text", async () => {
    use([
      graphqlRule(VIEW, {
        repository: rawRepository({
          description: null,
          homepageUrl: null,
          visibility: "INTERNAL",
          isTemplate: true,
          defaultBranchRef: null,
          viewerPermission: null,
          owner: { __typename: "User", login: "octo" },
          repositoryTopics: { nodes: [] },
          licenseInfo: null,
          templateRepository: { nameWithOwner: "octo/template" },
          parent: { nameWithOwner: "upstream/hello" },
          pushedAt: null,
        }),
      }),
    ])
    const { repository } = await run({ method: "view", repo: "octo/hello" })
    expect(repository).toMatchObject({
      description: "",
      homepage: "",
      visibility: "internal",
      is_template: true,
      fork: "upstream/hello",
      default_branch: null,
      topics: [],
      license: null,
      template: "octo/template",
      pushed_at: null,
      owner_type: "user",
      permission: null,
    })
  })

  test("repo names another repository", async () => {
    const installed = use([graphqlRule(VIEW, { repository: rawRepository({ nameWithOwner: "other/thing" }) })])
    expect((await run({ method: "view", repo: "other/thing" })).repository?.repo).toBe("other/thing")
    expect(graphqlCalls(installed)[0]!.vars).toEqual({ owner: "other", name: "thing" })
  })

  test("a missing repository is not_found", async () => {
    use([{ match: VIEW, stdout: repositoryReply(null) }])
    const error = await failure(run({ method: "view" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Repository octo/hello was not found, or the viewer cannot see it.")
  })

  test("GitHub's NOT_FOUND error is not_found too", async () => {
    use([{ match: VIEW, stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }]) }])
    expect((await failure(run({ method: "view", repo: "octo/gone" }))).code).toBe("not_found")
  })
})

describe("list", () => {
  test("the viewer's repositories by default, most recently pushed first, forks kept and archived left out", async () => {
    const installed = use([
      graphqlRule(LIST, {
        owner: { login: "alice", repositories: page([rawRow("one"), rawRow("two", { isFork: true })]) },
      }),
    ])
    expect(await run({ method: "list" })).toEqual({
      owner: "alice",
      repositories: [expectedRow("one"), expectedRow("two", { fork: true })],
      truncated: false,
    })
    const [call] = graphqlCalls(installed)
    expect(call!.query).toContain("owner: viewer{")
    expect(call!.query).toContain("ownerAffiliations:[OWNER]")
    expect(call!.query).toContain("orderBy:{field:PUSHED_AT,direction:DESC}")
    expect(call!.query).toContain("isArchived:false")
    expect(call!.query).not.toContain("isFork:")
    expect(call!.query).not.toContain("visibility:")
    expect(call!.vars).toEqual({ after: "null" })
  })

  test("owner names a login, and the filters narrow the query", async () => {
    const installed = use([graphqlRule(LIST, { owner: { login: "octo", repositories: page([]) } })])
    const result = await run({
      method: "list",
      owner: "Octo",
      visibility: "internal",
      include_forks: false,
      include_archived: true,
    })
    expect(result).toEqual({ owner: "octo", repositories: [], truncated: false })
    const [call] = graphqlCalls(installed)
    expect(call!.query).toContain("repositoryOwner(login:$login)")
    expect(call!.query).toContain("visibility:INTERNAL")
    expect(call!.query).toContain("isFork:false")
    expect(call!.query).not.toContain("isArchived:")
    expect(call!.vars).toEqual({ login: "Octo", after: "null" })
  })

  test("@me is the viewer", async () => {
    const installed = use([graphqlRule(LIST, { owner: { login: "alice", repositories: page([]) } })])
    await run({ method: "list", owner: "@me" })
    expect(graphqlCalls(installed)[0]!.query).toContain("owner: viewer{")
  })

  test("pages are followed from the cursor, up to the limit", async () => {
    const installed = use([
      graphqlRule(LIST, { owner: { login: "octo", repositories: page([rawRow("a"), rawRow("b")], "c1") } }, 1),
      graphqlRule(LIST, { owner: { login: "octo", repositories: page([rawRow("c")]) } }),
    ])
    const result = await run({ method: "list", owner: "octo" })
    expect(result.repositories?.map((row) => row.repo)).toEqual(["octo/a", "octo/b", "octo/c"])
    expect(result.truncated).toBe(false)
    expect(graphqlCalls(installed).map((call) => call.vars.after)).toEqual(["null", "c1"])
  })

  test("limit cuts the rows and truncated says more matched", async () => {
    const installed = use([
      graphqlRule(LIST, { owner: { login: "octo", repositories: page([rawRow("a"), rawRow("b")], "c1") } }),
    ])
    const result = await run({ method: "list", owner: "octo", limit: 2 })
    expect(result.repositories?.map((row) => row.repo)).toEqual(["octo/a", "octo/b"])
    expect(result.truncated).toBe(true)
    expect(graphqlCalls(installed)).toHaveLength(1)
  })

  test("an owner that does not exist is not_found", async () => {
    use([graphqlRule(LIST, { owner: null })])
    const error = await failure(run({ method: "list", owner: "nobody" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Owner nobody was not found, or the viewer cannot see it.")
  })

  test.each([0, 1001, 1.5])("invalid limit %p", async (limit) => {
    use([])
    expect((await failure(run({ method: "list", limit }))).code).toBe("invalid_argument")
  })

  test("an owner that is no login is invalid_argument, and nothing is read", async () => {
    const installed = use([])
    expect((await failure(run({ method: "list", owner: "octo/hello" }))).code).toBe("invalid_argument")
    expect(graphqlCalls(installed)).toEqual([])
  })
})

describe("argument refusals", () => {
  test.each([
    ["owner", "octo"],
    ["visibility", "public"],
    ["include_archived", true],
    ["include_forks", false],
    ["limit", 5],
  ])("view refuses %s", async (name, value) => {
    const installed = use([])
    const error = await failure(run({ method: "view", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(`"${name}" is an argument of method "list", not "view"; leave it out.`)
    expect(graphqlCalls(installed)).toEqual([])
  })

  test("list refuses repo", async () => {
    const error = await failure(run({ method: "list", repo: "octo/hello" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"repo" is an argument of method "view", not "list"; leave it out.')
  })
})
