import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { sent } from "./write-fixtures"

/** Replies of GitHub the repository read tools meet, and a view of the GraphQL calls a fake `gh` saw. */

type Extra = Record<string, unknown>

/** One GraphQL call: its query text and the variables sent as `-f` / `-F` flags. */
export type GraphqlCall = { query: string; vars: Record<string, string> }

export function graphqlCalls(installed: FakeGh): GraphqlCall[] {
  return sent(installed).flatMap((args) => {
    if (args[0] !== "api" || args[1] !== "graphql") return []
    const vars: Record<string, string> = {}
    let query = ""
    for (let index = 2; index < args.length; index += 2) {
      const [name, value] = args[index + 1]!.split(/=(.*)/s)
      if (name === "query") query = value!
      else vars[name!] = value!
    }
    return [{ query, vars }]
  })
}

/** The paths of the REST calls that went out. */
export const restPaths = (installed: FakeGh): string[] =>
  sent(installed).flatMap((args) => (args[0] === "api" && args[1] !== "graphql" ? [args[1]!] : []))

/** A GraphQL reply of `octo/hello` that holds `repository`. */
export const repositoryReply = (repository: unknown): string => gqlReply({ repository })

/** One page of a connection, `next` being the cursor of the page after it (none for the last). */
export const page = (nodes: unknown[], next: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
})

/** A GraphQL rule for a call whose query holds `token`, answering `stdout`; `times` limits how many calls it answers. */
export const graphqlRule = (token: string, data: unknown, times?: number): GhRule => ({
  match: token,
  stdout: gqlReply(data),
  times,
})

/** A call `gh api` reports as failed with the HTTP status on stderr and GitHub's body on stdout. */
export const restFailure = (match: string, status: string, body: Extra = {}): GhRule => ({
  match,
  stderr: `gh: ${status}`,
  stdout: JSON.stringify(body),
  code: 1,
})

/** A token only the repository view query holds. */
export const REPOSITORY_VIEW = "homepageUrl"

/** The view query's repository as GraphQL returns it: an organization's public `octo/hello`, administered by the viewer. */
export const rawRepository = (extra: Extra = {}) => ({
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

/** The view query answering with `rawRepository(extra)`. */
export const repositoryViewRule = (extra: Extra = {}): GhRule =>
  graphqlRule(REPOSITORY_VIEW, { repository: rawRepository(extra) })

/** The owner query answering for `owner`: the viewer `viewer`, and the owner as a `type` (null: no such owner). */
export const repositoryOwnerRule = (
  owner: string,
  options: { viewer?: string; type?: "User" | "Organization" | null } = {},
): GhRule =>
  graphqlRule("repositoryOwner\\(login:", {
    viewer: { login: options.viewer ?? "alice" },
    repositoryOwner: options.type === null ? null : { __typename: options.type ?? "User", login: owner },
  })

/** The repository-facts query for `owner/name`: it does not exist (`null`), or is a template or not. */
export const repositoryFactsRule = (full: string, facts: { isTemplate: boolean } | null): GhRule => {
  const [owner, name] = full.split("/")
  return graphqlRule(`nameWithOwner isTemplate.* owner=${owner} -f name=${name}$`, {
    repository: facts && { nameWithOwner: full, ...facts },
  })
}

export const labelPages = (labels: unknown[], next: string | null = null, times?: number): GhRule =>
  graphqlRule("labels\\(first:100", { repository: { labels: page(labels, next) } }, times)

export const milestonePages = (milestones: unknown[], next: string | null = null): GhRule =>
  graphqlRule("milestones\\(first:100", { repository: { milestones: page(milestones, next) } })

export const LABEL_ROW = { name: "Bug", color: "d73a4a", description: "Something is broken" }
export const MILESTONE_ROW = {
  number: 1,
  title: "Release",
  state: "OPEN",
  dueOn: "2026-12-01T12:00:00Z",
  description: "Next release",
  openIssueCount: 2,
  closedIssueCount: 1,
  url: "https://github.com/octo/hello/milestone/1",
}

export const milestoneRest = (overrides: Extra = {}) => ({
  number: 1,
  title: "Release",
  state: "open",
  due_on: MILESTONE_ROW.dueOn,
  description: MILESTONE_ROW.description,
  html_url: MILESTONE_ROW.url,
  ...overrides,
})

/** A ruleset of `octo/hello` as GitHub's REST API returns it, defined by the repository itself. */
export const rawRuleset = (extra: Extra = {}) => ({
  id: 7,
  name: "Protect main",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  source: "octo/hello",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }],
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  created_at: "2026-11-03T12:44:43.508+08:00",
  updated_at: "2026-11-04T14:20:32.084+08:00",
  _links: { html: { href: "https://github.com/octo/hello/rules/7" } },
  ...extra,
})

/** `rawRuleset()` as the ruleset tools report it, with `extra` laid over. */
export const rulesetView = (extra: Extra = {}) => ({
  id: 7,
  name: "Protect main",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  source: "octo/hello",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [
    { type: "deletion", parameters: null },
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
  ],
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  created_at: "2026-11-03T12:44:43.508+08:00",
  updated_at: "2026-11-04T14:20:32.084+08:00",
  url: "https://github.com/octo/hello/rules/7",
  ...extra,
})

/** The list of the repository's own rulesets (the read that checks names), one page holding `rulesets`. */
export const rulesetListRule = (...rulesets: unknown[]): GhRule => ({
  match: "rulesets\\?includes_parents=false",
  stdout: JSON.stringify([rulesets]),
})

/** The read of the ruleset with `raw`'s id, answering `raw`. */
export const rulesetGetRule = (raw: { id: number }): GhRule => ({
  match: `rulesets/${raw.id}$`,
  stdout: JSON.stringify(raw),
})

/** The REST mutations with their JSON request bodies, in order. */
export function writeLog(installed: FakeGh): { args: string[]; body: unknown }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) =>
      args[0] === "api" && args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))
        ? [{ args, body: stdins[index] ? JSON.parse(stdins[index]!) : null }]
        : [],
    )
}
