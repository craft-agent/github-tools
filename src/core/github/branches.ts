import { ToolError, isToolError } from "../errors"
import { ghJson, graphql } from "../gh"
import type { RefContext, RepoName } from "../refs"

/** Branch and tag reads of one repository. */

const DEFAULT_BRANCH_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}"

/** The name of the repository's default branch; `null` for a repository without one, such as an empty one. */
export async function defaultBranch(repo: RepoName, ctx: RefContext): Promise<string | null> {
  const data = await graphql<{ repository?: { defaultBranchRef?: { name?: string } | null } | null } | null>(
    DEFAULT_BRANCH_QUERY,
    { owner: repo.owner, name: repo.name },
    ctx,
  )
  if (!data?.repository) {
    throw new ToolError("not_found", `Repository ${repo.full} was not found, or the viewer cannot see it.`)
  }
  return data.repository.defaultBranchRef?.name ?? null
}

/** Encodes each segment between slashes with `encodeURIComponent`, leaving slashes intact. */
export function encodePathSegments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/")
}

/**
 * The commit a branch of the repository points at, or `null` when there is no
 * such branch; any failure but GitHub's "not found" is thrown. The slashes of
 * the name stay, the rest of each segment is encoded.
 */
export async function branchHead(repo: RepoName, branch: string, ctx: RefContext): Promise<string | null> {
  const path = encodePathSegments(branch)
  let reply: { commit?: { sha?: string } } | null
  try {
    reply = await ghJson(["api", `repos/${repo.owner}/${repo.name}/branches/${path}`], ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return null
    throw error
  }
  const sha = reply?.commit?.sha
  if (!sha) {
    throw new ToolError("upstream_error", `GitHub returned no head commit for branch ${branch} of ${repo.full}.`)
  }
  return sha
}

type GitObjectReply = { object?: { sha?: string; type?: string } }

/**
 * Returns the commit a git tag points to, peeling annotated tags until a commit
 * is reached, or `null` when the tag does not exist.
 */
export async function tagCommit(repo: RepoName, tag: string, ctx: RefContext): Promise<string | null> {
  const path = encodePathSegments(tag)
  let reply: GitObjectReply | null
  try {
    reply = await ghJson<GitObjectReply>(["api", `repos/${repo.owner}/${repo.name}/git/ref/tags/${path}`], ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return null
    throw error
  }
  const initialSha = reply?.object?.sha
  let type = reply?.object?.type
  if (!initialSha || !type) {
    throw new ToolError("upstream_error", `GitHub returned no ref object for tag ${tag} of ${repo.full}.`)
  }
  let sha = initialSha
  while (type === "tag") {
    const peeled: GitObjectReply | null = await ghJson<GitObjectReply>(
      ["api", `repos/${repo.owner}/${repo.name}/git/tags/${sha}`],
      ctx,
    )
    if (!peeled?.object?.sha || !peeled.object.type) {
      throw new ToolError("upstream_error", `GitHub returned no object for annotated tag ${sha} of ${repo.full}.`)
    }
    sha = peeled.object.sha
    type = peeled.object.type
  }
  return sha
}
