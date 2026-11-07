import { ToolError, isAbortError, isToolError, type ErrorCode } from "../errors"
import { graphql } from "../gh"
import type { RefContext, RepoName } from "../refs"

export type OwnerType = "User" | "Organization"

const PERMISSIONS = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] as const

export type Permission = (typeof PERMISSIONS)[number]

/** The repository a call is about, with what the viewer may do there. */
export type RepositoryContext = {
  repo: RepoName
  /** The repository's node id. */
  id: string
  owner_type: OwnerType
  /** The login of the person `gh` is authenticated as. */
  viewer: string
  /** `null` when GitHub does not report one. */
  permission: Permission | null
  /** Whether the repository is someone else's tracker: the viewer is not its owner nor a member of the owning organization. */
  foreign: boolean
}

const WRITE_PERMISSIONS: readonly Permission[] = ["ADMIN", "MAINTAIN", "WRITE"]
const MAX_ISSUE_TYPES = 25

const REPOSITORY_QUERY = `query($owner:String!,$name:String!){
  viewer{login}
  repository(owner:$owner,name:$name){id nameWithOwner viewerPermission owner{__typename login}}
}`
const MEMBERSHIP_QUERY = "query($login:String!){organization(login:$login){viewerIsAMember}}"
const ISSUE_TYPES_QUERY = `query($login:String!){repositoryOwner(login:$login){__typename ... on Organization{issueTypes(first:${MAX_ISSUE_TYPES}){nodes{name isEnabled}}}}}`
/** Failures of the Issue Types read that mean "none to use here"; any other failure is the call's. */
const ISSUE_TYPES_SOFT_CODES: readonly ErrorCode[] = ["not_found", "forbidden"]

type RepositoryReply = {
  viewer?: { login?: string } | null
  repository?: {
    id: string
    nameWithOwner: string
    viewerPermission?: string | null
    owner: { __typename: string; login: string }
  } | null
}

/** The `not_found` for a repository that does not exist or that the viewer cannot see. */
export function repositoryNotFound(full: string, cause?: unknown): ToolError {
  return new ToolError("not_found", `Repository ${full} was not found, or the viewer cannot see it.`, { cause })
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether the viewer belongs to the organization; a failed read counts as no, the stricter answer. */
async function isMember(login: string, ctx: RefContext): Promise<boolean> {
  try {
    const data = await graphql<{ organization?: { viewerIsAMember?: boolean } | null } | null>(
      MEMBERSHIP_QUERY,
      { login },
      ctx,
    )
    return Boolean(data?.organization?.viewerIsAMember)
  } catch (error) {
    if (isAbortError(error)) throw error
    return false
  }
}

/**
 * Reads who owns `repo`, who the viewer is and what the viewer may do there,
 * so every tool reports the same facts. A repository that does not exist or
 * cannot be seen is `not_found`.
 */
export async function repositoryContext(repo: RepoName, ctx: RefContext): Promise<RepositoryContext> {
  let data: RepositoryReply | null
  try {
    data = await graphql<RepositoryReply | null>(REPOSITORY_QUERY, { owner: repo.owner, name: repo.name }, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
  const found = data?.repository
  if (!found) throw repositoryNotFound(repo.full)

  const viewer = data?.viewer?.login ?? ""
  const ownerType: OwnerType = found.owner.__typename === "Organization" ? "Organization" : "User"
  const [owner = found.owner.login, name = repo.name] = found.nameWithOwner.split("/")
  const permission = PERMISSIONS.find((level) => level === found.viewerPermission) ?? null
  const ownedByViewer = sameLogin(found.owner.login, viewer)
  const foreign = !ownedByViewer && (ownerType === "User" || !(await isMember(found.owner.login, ctx)))

  return {
    repo: { owner, name, full: found.nameWithOwner },
    id: found.id,
    owner_type: ownerType,
    viewer,
    permission,
    foreign,
  }
}

/** Throws `forbidden` unless the viewer may write to the repository, so a write fails before it changes anything. */
export function assertWritable(context: RepositoryContext): void {
  if (context.permission && WRITE_PERMISSIONS.includes(context.permission)) return
  throw new ToolError(
    "forbidden",
    `No write permission on ${context.repo.full} (the viewer's permission there is ${context.permission ?? "none"}). Use a repository the viewer can write to, or ask for access.`,
  )
}

const issueTypesByOwner = new Map<string, string[]>()

/** Forgets the cached Issue Types. For tests only, which change the replies between cases. */
export function resetIssueTypeCache(): void {
  issueTypesByOwner.clear()
}

/**
 * The names of the Issue Types the repository's owner has enabled, from one
 * read of the owner: empty for a user, who has none. Cached per process per
 * owner. A read GitHub refuses (`not_found`, `forbidden`) yields an empty list
 * that is not cached, so a later call retries; any other failure is thrown, so
 * a kind is never matched by label only because GitHub could not be asked.
 */
export async function issueTypes(repo: RepoName, ctx: RefContext): Promise<string[]> {
  const key = repo.owner.toLowerCase()
  const cached = issueTypesByOwner.get(key)
  if (cached) return cached
  let data: {
    repositoryOwner?: {
      __typename?: string
      issueTypes?: { nodes?: { name: string; isEnabled?: boolean }[] | null } | null
    } | null
  } | null
  try {
    data = await graphql(ISSUE_TYPES_QUERY, { login: repo.owner }, ctx)
  } catch (error) {
    if (isToolError(error) && ISSUE_TYPES_SOFT_CODES.includes(error.code)) return []
    throw error
  }
  const owner = data?.repositoryOwner
  if (!owner) return []
  const names = (owner.issueTypes?.nodes ?? []).filter((type) => type.isEnabled).map((type) => type.name)
  issueTypesByOwner.set(key, names)
  return names
}
