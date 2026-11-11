import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { gh, ghJson, graphql, paginate, type Page, type Vars } from "../gh"
import { parseRepo, type RefContext, type RepoName } from "../refs"
import { refusalAsInvalid } from "./refusal"
import { repositoryNotFound } from "./repository"

const TOPIC_LIMIT = 20
const PERMISSION_LEVELS = ["admin", "maintain", "write", "triage", "read"] as const
const VISIBILITIES = ["public", "private", "internal"] as const
const OWNER_TYPES = ["user", "organization"] as const

export const visibilitySchema = z.enum(VISIBILITIES)

export type Visibility = z.output<typeof visibilitySchema>

export const repositorySchema = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  url: z.string(),
  description: z.string().describe("Empty when there is none."),
  homepage: z.string().describe("The homepage link; empty when there is none."),
  visibility: visibilitySchema,
  archived: z.boolean(),
  is_template: z.boolean().describe("Whether the repository is a template others can create repositories from."),
  fork: z.string().nullable().describe("The repository this one is a fork of, as owner/name; null when it is no fork."),
  default_branch: z.string().nullable().describe("null for an empty repository."),
  topics: z.array(z.string()),
  license: z.string().nullable().describe("The license's SPDX id; null when GitHub detects none."),
  template: z.string().nullable().describe("The template the repository was created from, as owner/name, or null."),
  pushed_at: z.string().nullable().describe("When anything was last pushed, as a timestamp; null for an empty one."),
  owner_type: z.enum(OWNER_TYPES),
  permission: z
    .enum(PERMISSION_LEVELS)
    .nullable()
    .describe("What the viewer may do there; null when GitHub says none."),
  features: z.object({
    issues: z.boolean(),
    wiki: z.boolean(),
    projects: z.boolean(),
    discussions: z.boolean(),
  }),
  merge: z.object({
    merge_commit: z.boolean().describe("Whether merge commits are allowed."),
    squash: z.boolean().describe("Whether squash merging is allowed."),
    rebase: z.boolean().describe("Whether rebase merging is allowed."),
    auto_merge: z.boolean().describe("Whether pull requests may be set to merge once their checks pass."),
    delete_branch_on_merge: z.boolean().describe("Whether a merged pull request's branch is deleted."),
    update_branch: z.boolean().describe("Whether a pull request's branch may be updated from its base."),
  }),
})

export const repositoryRowSchema = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  url: z.string(),
  description: z.string().describe("Empty when there is none."),
  visibility: visibilitySchema,
  archived: z.boolean(),
  fork: z.boolean(),
  default_branch: z.string().nullable().describe("null for an empty repository."),
  pushed_at: z.string().nullable().describe("When anything was last pushed, as a timestamp; null for an empty one."),
})

export type Repository = z.output<typeof repositorySchema>
export type RepositoryRow = z.output<typeof repositoryRowSchema>

type RawRepositoryRow = {
  nameWithOwner: string
  url: string
  description?: string | null
  visibility: string
  isArchived: boolean
  isFork: boolean
  defaultBranchRef?: { name: string } | null
  pushedAt?: string | null
}

type RawRepository = RawRepositoryRow & {
  homepageUrl?: string | null
  isTemplate: boolean
  viewerPermission?: string | null
  owner: { __typename: string }
  hasIssuesEnabled: boolean
  hasWikiEnabled: boolean
  hasProjectsEnabled: boolean
  hasDiscussionsEnabled: boolean
  mergeCommitAllowed: boolean
  squashMergeAllowed: boolean
  rebaseMergeAllowed: boolean
  autoMergeAllowed: boolean
  deleteBranchOnMerge: boolean
  allowUpdateBranch: boolean
  repositoryTopics?: { nodes?: ({ topic?: { name: string } | null } | null)[] | null } | null
  licenseInfo?: { spdxId?: string | null } | null
  templateRepository?: { nameWithOwner: string } | null
  parent?: { nameWithOwner: string } | null
}

const REPOSITORY_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    nameWithOwner url description homepageUrl visibility isArchived isTemplate isFork defaultBranchRef{name} viewerPermission owner{__typename login}
    hasIssuesEnabled hasWikiEnabled hasProjectsEnabled hasDiscussionsEnabled
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge allowUpdateBranch
    repositoryTopics(first:${TOPIC_LIMIT}){nodes{topic{name}}}
    licenseInfo{spdxId} templateRepository{nameWithOwner} parent{nameWithOwner} pushedAt
  }
}`

const ROW_FIELDS = "nameWithOwner url description visibility isArchived isFork defaultBranchRef{name} pushedAt"

const OWNER_QUERY = "query($owner:String!){ viewer{login} repositoryOwner(login:$owner){__typename login} }"
const FACTS_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ nameWithOwner isTemplate } }"

/** The `not_found` for a user or organization that does not exist or that the viewer cannot see. */
function ownerNotFound(owner: string, cause?: unknown): ToolError {
  return new ToolError("not_found", `Owner ${owner} was not found, or the viewer cannot see it.`, { cause })
}

/**
 * The repository's own part of a GraphQL reply to `query`, which takes `$owner`
 * and `$name` (plus `vars`). A repository that does not exist or cannot be seen
 * is `not_found`.
 */
export async function readRepositoryData<T>(repo: RepoName, query: string, vars: Vars, ctx: RefContext): Promise<T> {
  let data: { repository?: T | null } | null
  try {
    data = await graphql(query, { owner: repo.owner, name: repo.name, ...vars }, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
  if (!data?.repository) throw repositoryNotFound(repo.full)
  return data.repository
}

/**
 * Walks a connection of the repository: `query` takes `$owner`, `$name` and
 * `$after`, and `connection` picks the connection from the repository. Stops
 * at `limit` nodes; `truncated` says the limit left some out. A repository that
 * does not exist or cannot be seen is `not_found`.
 */
export async function readRepositoryPages<T>(
  repo: RepoName,
  query: string,
  connection: (repository: any) => Page<T> | null | undefined,
  options: RefContext & { limit: number },
): Promise<{ items: T[]; truncated: boolean }> {
  try {
    return await paginate(
      query,
      { owner: repo.owner, name: repo.name },
      (data) => {
        if (!data?.repository) throw repositoryNotFound(repo.full)
        return connection(data.repository)
      },
      options,
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
}

function permissionOf(value: string | null | undefined): Repository["permission"] {
  return PERMISSION_LEVELS.find((level) => level === value?.toLowerCase()) ?? null
}

function visibilityOf(value: string): Visibility {
  return VISIBILITIES.find((visibility) => visibility === value.toLowerCase()) ?? "private"
}

function toRow(raw: RawRepositoryRow): RepositoryRow {
  return {
    repo: raw.nameWithOwner,
    url: raw.url,
    description: raw.description ?? "",
    visibility: visibilityOf(raw.visibility),
    archived: raw.isArchived,
    fork: raw.isFork,
    default_branch: raw.defaultBranchRef?.name ?? null,
    pushed_at: raw.pushedAt ?? null,
  }
}

/** One repository's settings and facts; a repository that does not exist or cannot be seen is `not_found`. */
export async function readRepositoryView(repo: RepoName, ctx: RefContext): Promise<Repository> {
  const raw = await readRepositoryData<RawRepository>(repo, REPOSITORY_QUERY, {}, ctx)
  return {
    repo: raw.nameWithOwner,
    url: raw.url,
    description: raw.description ?? "",
    homepage: raw.homepageUrl ?? "",
    visibility: visibilityOf(raw.visibility),
    archived: raw.isArchived,
    is_template: raw.isTemplate,
    fork: raw.parent?.nameWithOwner ?? null,
    default_branch: raw.defaultBranchRef?.name ?? null,
    topics: (raw.repositoryTopics?.nodes ?? []).flatMap((node) => (node?.topic ? [node.topic.name] : [])),
    license: raw.licenseInfo?.spdxId ?? null,
    template: raw.templateRepository?.nameWithOwner ?? null,
    pushed_at: raw.pushedAt ?? null,
    owner_type: raw.owner.__typename === "Organization" ? "organization" : "user",
    permission: permissionOf(raw.viewerPermission),
    features: {
      issues: raw.hasIssuesEnabled,
      wiki: raw.hasWikiEnabled,
      projects: raw.hasProjectsEnabled,
      discussions: raw.hasDiscussionsEnabled,
    },
    merge: {
      merge_commit: raw.mergeCommitAllowed,
      squash: raw.squashMergeAllowed,
      rebase: raw.rebaseMergeAllowed,
      auto_merge: raw.autoMergeAllowed,
      delete_branch_on_merge: raw.deleteBranchOnMerge,
      update_branch: raw.allowUpdateBranch,
    },
  }
}

export type RepositoryListOptions = {
  visibility?: Visibility
  includeArchived: boolean
  includeForks: boolean
  limit: number
}

/** The query that lists the repositories of `login`, or of the viewer when there is none, newest push first. */
function repositoriesQuery(login: string | undefined, options: RepositoryListOptions): string {
  const connectionArguments = [
    "first:100",
    "after:$after",
    "ownerAffiliations:[OWNER]",
    "orderBy:{field:PUSHED_AT,direction:DESC}",
    ...(options.visibility ? [`visibility:${options.visibility.toUpperCase()}`] : []),
    ...(options.includeArchived ? [] : ["isArchived:false"]),
    ...(options.includeForks ? [] : ["isFork:false"]),
  ].join(",")
  const root = login === undefined ? "viewer" : "repositoryOwner(login:$login)"
  const variables = login === undefined ? "$after:String" : "$login:String!,$after:String"
  return `query(${variables}){ owner: ${root}{ login repositories(${connectionArguments}){ nodes{${ROW_FIELDS}} pageInfo{hasNextPage endCursor} } } }`
}

/**
 * The repositories `owner` owns (the viewer's when it is undefined), most
 * recently pushed first, at most `options.limit`; `truncated` says more matched.
 * An owner that does not exist is `not_found`.
 */
export async function listRepositories(
  owner: string | undefined,
  options: RepositoryListOptions,
  ctx: RefContext,
): Promise<{ owner: string; repositories: RepositoryRow[]; truncated: boolean }> {
  const notFound = (cause?: unknown) => ownerNotFound(owner ?? "@me", cause)
  let login = owner ?? ""
  let result: { items: RawRepositoryRow[]; truncated: boolean }
  try {
    result = await paginate<RawRepositoryRow>(
      repositoriesQuery(owner, options),
      { login: owner },
      (data) => {
        if (!data?.owner) throw notFound()
        login = data.owner.login
        return data.owner.repositories
      },
      { ...ctx, limit: options.limit },
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found" && owner !== undefined) throw notFound(error)
    throw error
  }
  return { owner: login, repositories: result.items.map(toRow), truncated: result.truncated }
}

/** Throws `forbidden` unless the viewer administers the repository, so a settings write fails before it changes anything. */
export function assertAdmin(repository: Repository): void {
  if (repository.permission === "admin") return
  throw new ToolError(
    "forbidden",
    `No admin permission on ${repository.repo} (the viewer's permission there is ${repository.permission ?? "none"}). Ask an administrator of the repository, or use one the viewer administers.`,
  )
}

/** The repository's settings and facts once the viewer is known to administer it, with the name GitHub knows it by. */
export async function readAdministeredRepository(
  repo: RepoName,
  ctx: RefContext,
): Promise<{ view: Repository; target: RepoName }> {
  const view = await readRepositoryView(repo, ctx)
  assertAdmin(view)
  return { view, target: parseRepo(view.repo) }
}

/** Who a repository can be created for: the viewer, an organization, or another user (which the viewer cannot create for). */
export type RepositoryOwner = { login: string; kind: "viewer" | "organization" | "user" }

/** Reads the user or organization `login` and whether it is the viewer; one that does not exist is `not_found`. */
export async function readRepositoryOwner(login: string, ctx: RefContext): Promise<RepositoryOwner> {
  let data: {
    viewer?: { login?: string } | null
    repositoryOwner?: { __typename: string; login: string } | null
  } | null
  try {
    data = await graphql(OWNER_QUERY, { owner: login }, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw ownerNotFound(login, error)
    throw error
  }
  const owner = data?.repositoryOwner
  if (!owner) throw ownerNotFound(login)
  if (owner.login.toLowerCase() === data?.viewer?.login?.toLowerCase()) return { login: owner.login, kind: "viewer" }
  return { login: owner.login, kind: owner.__typename === "Organization" ? "organization" : "user" }
}

/** Whether the repository exists (for the viewer) and is a template, or `null` when it does not exist or cannot be seen. */
export async function findRepository(repo: RepoName, ctx: RefContext): Promise<{ is_template: boolean } | null> {
  try {
    const found = await readRepositoryData<{ isTemplate: boolean }>(repo, FACTS_QUERY, {}, ctx)
    return { is_template: found.isTemplate }
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return null
    throw error
  }
}

/** Sends `PATCH repos/{owner}/{name}` with `body`: the settings, archive state and visibility share this one endpoint. */
export async function patchRepository(repo: RepoName, body: Record<string, unknown>, ctx: RefContext): Promise<void> {
  await refusalAsInvalid(() =>
    gh(["api", "-X", "PATCH", `repos/${repo.full}`, "--input", "-"], { ...ctx, stdin: JSON.stringify(body) }),
  )
}

/** Replaces the repository's topics with `names`. */
export async function replaceTopics(repo: RepoName, names: string[], ctx: RefContext): Promise<void> {
  await refusalAsInvalid(() =>
    gh(["api", "-X", "PUT", `repos/${repo.full}/topics`, "--input", "-"], {
      ...ctx,
      stdin: JSON.stringify({ names }),
    }),
  )
}

/**
 * Sends the create (or generate-from-template) request to `endpoint` and
 * returns the repository GitHub made; `visibility` is `undefined` when the reply
 * names none GitHub's vocabulary knows.
 */
export async function createRepository(
  endpoint: string,
  body: Record<string, unknown>,
  ctx: RefContext,
): Promise<{ repo: string; url: string; visibility: Visibility | undefined }> {
  const raw = await refusalAsInvalid(() =>
    ghJson<{ full_name?: string; html_url?: string; visibility?: string }>(
      ["api", "-X", "POST", endpoint, "--input", "-"],
      { ...ctx, stdin: JSON.stringify(body) },
    ),
  )
  if (!raw?.full_name || !raw.html_url) {
    throw new ToolError("upstream_error", "GitHub did not return the repository it created.")
  }
  return { repo: raw.full_name, url: raw.html_url, visibility: visibilitySchema.safeParse(raw.visibility).data }
}
