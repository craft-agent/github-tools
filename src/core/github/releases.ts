import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { branchHead, encodePathSegments } from "./branches"
import { repositoryNotFound } from "./repository"

/** Release reads of one repository. */

const SHA_PATTERN = /^[0-9a-f]{40}$/i
/** The most releases GitHub returns in one page. */
const PAGE_SIZE = 100
/** The most releases scanned when searching for a draft release. */
const MAX_DRAFT_SCAN = 1000

export const releaseAssetSchema = z.object({
  name: z.string().describe("The asset file name."),
  size: z.number().int().describe("The asset size in bytes."),
  download_count: z.number().int().describe("How many times the asset has been downloaded."),
  url: z.string().describe("The browser download URL for the asset."),
})

export type ReleaseAsset = z.output<typeof releaseAssetSchema>

/** A release as a list reports it. */
export const releaseRowSchema = z.object({
  tag: z.string().describe("The git tag name of the release."),
  title: z.string().describe("The title of the release; empty when none."),
  draft: z.boolean().describe("Whether the release is an unpublished draft."),
  prerelease: z.boolean().describe("Whether the release is marked as a pre-release."),
  latest: z.boolean().describe("Whether this is the repository's latest release."),
  created_at: z.string().describe("When the release was created, as an ISO timestamp."),
  published_at: z.string().nullable().describe("When the release was published; null for a draft."),
})

export type ReleaseRow = z.output<typeof releaseRowSchema>

/** One release with full details, notes, assets and commit facts. */
export const releaseSchema = releaseRowSchema.extend({
  url: z.string().describe("The release's page on GitHub."),
  notes: z.string().describe("The release description or changelog; empty when none."),
  author: z.string().nullable().describe("The login of the user who created the release; null when unavailable."),
  target: z.string().describe("The branch or commit a new tag is made from (target_commitish)."),
  tag_exists: z.boolean().describe("Whether the git tag exists on GitHub yet."),
  commit: z
    .string()
    .nullable()
    .describe(
      "The commit the tag names when it exists; otherwise the commit publishing would tag, or null if the target branch is gone.",
    ),
  immutable: z.boolean().describe("Whether the release is immutable; false when absent."),
  updated_at: z.string().describe("When the release was last updated, as an ISO timestamp."),
  assets: z.array(releaseAssetSchema).describe("The release assets uploaded to this release."),
})

export type Release = z.output<typeof releaseSchema>

export type RestAsset = Omit<ReleaseAsset, "url"> & {
  browser_download_url: string
}

export type RestRelease = {
  id: number
  tag_name: string
  name?: string | null
  body?: string | null
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at?: string | null
  html_url: string
  target_commitish: string
  immutable?: boolean
  updated_at: string
  author?: { login: string } | null
  assets?: RestAsset[]
}

function toAsset(raw: RestAsset): ReleaseAsset {
  return {
    name: raw.name,
    size: raw.size,
    download_count: raw.download_count,
    url: raw.browser_download_url,
  }
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
    throw new ToolError("github_error", `GitHub returned no ref object for tag ${tag} of ${repo.full}.`)
  }
  let sha = initialSha
  while (type === "tag") {
    const peeled: GitObjectReply | null = await ghJson<GitObjectReply>(
      ["api", `repos/${repo.owner}/${repo.name}/git/tags/${sha}`],
      ctx,
    )
    if (!peeled?.object?.sha || !peeled.object.type) {
      throw new ToolError("github_error", `GitHub returned no object for annotated tag ${sha} of ${repo.full}.`)
    }
    sha = peeled.object.sha
    type = peeled.object.type
  }
  return sha
}

async function latestReleaseId(repo: RepoName, ctx: RefContext): Promise<number | null> {
  try {
    const latest = await ghJson<{ id?: number }>(["api", `repos/${repo.owner}/${repo.name}/releases/latest`], ctx)
    return typeof latest?.id === "number" ? latest.id : null
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return null
    throw error
  }
}

function toRow(raw: RestRelease, latestId: number | null): ReleaseRow {
  return {
    tag: raw.tag_name,
    title: raw.name ?? "",
    draft: Boolean(raw.draft),
    prerelease: Boolean(raw.prerelease),
    latest: latestId !== null && raw.id === latestId,
    created_at: raw.created_at,
    published_at: raw.draft ? null : (raw.published_at ?? null),
  }
}

/** One page of the repository's releases, newest first; a missing repository is `not_found`. */
async function releasePage(repo: RepoName, page: number, ctx: RefContext): Promise<RestRelease[]> {
  try {
    return (
      (await ghJson<RestRelease[]>(
        ["api", `repos/${repo.owner}/${repo.name}/releases?per_page=${PAGE_SIZE}&page=${page}`],
        ctx,
      )) ?? []
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
}

/**
 * Lists the releases of `repo`, newest first, including drafts. `truncated` is
 * true when more releases existed than `options.limit`.
 */
export async function listReleases(
  repo: RepoName,
  options: { limit: number },
  ctx: RefContext,
): Promise<{ releases: ReleaseRow[]; truncated: boolean }> {
  const all: RestRelease[] = []
  for (let page = 1; all.length <= options.limit; page++) {
    const items = await releasePage(repo, page, ctx)
    all.push(...items)
    if (items.length < PAGE_SIZE) break
  }

  const latestId = await latestReleaseId(repo, ctx)
  return {
    releases: all.slice(0, options.limit).map((release) => toRow(release, latestId)),
    truncated: all.length > options.limit,
  }
}

/**
 * Reads one release by tag (published or draft). A missing release throws
 * `not_found`.
 */
export async function readRelease(repo: RepoName, tag: string, ctx: RefContext): Promise<Release> {
  const path = encodePathSegments(tag)
  let raw: RestRelease | null = null
  try {
    raw = await ghJson<RestRelease>(["api", `repos/${repo.owner}/${repo.name}/releases/tags/${path}`], ctx)
  } catch (error) {
    if (!isToolError(error) || error.code !== "not_found") throw error
  }

  // GitHub finds no draft by its tag, so a draft is looked for among the listed releases.
  for (let page = 1; !raw && (page - 1) * PAGE_SIZE < MAX_DRAFT_SCAN; page++) {
    const items = await releasePage(repo, page, ctx)
    raw = items.find((candidate) => candidate.draft && candidate.tag_name === tag) ?? null
    if (items.length < PAGE_SIZE) break
  }

  if (!raw) {
    throw new ToolError("not_found", `Release ${tag} was not found in ${repo.full}, or the viewer cannot see it.`)
  }

  const latestId = await latestReleaseId(repo, ctx)
  const tagCommitSha = await tagCommit(repo, raw.tag_name, ctx)
  const tagExists = tagCommitSha !== null

  let commitSha: string | null = null
  if (tagExists) {
    commitSha = tagCommitSha
  } else if (SHA_PATTERN.test(raw.target_commitish)) {
    commitSha = raw.target_commitish
  } else {
    commitSha = await branchHead(repo, raw.target_commitish, ctx)
  }

  return {
    ...toRow(raw, latestId),
    url: raw.html_url,
    notes: raw.body ?? "",
    author: raw.author?.login ?? null,
    target: raw.target_commitish,
    tag_exists: tagExists,
    commit: commitSha,
    immutable: Boolean(raw.immutable),
    updated_at: raw.updated_at,
    assets: (raw.assets ?? []).map(toAsset),
  }
}
