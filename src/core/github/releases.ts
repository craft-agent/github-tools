import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { gh, ghJson } from "../gh"
import { SHA_PATTERN, type RefContext, type RepoName } from "../refs"
import { branchHead, encodePathSegments, tagCommit } from "./branches"
import { refusalAsInvalid } from "./refusal"
import { repositoryNotFound } from "./repository"

/** Release reads and writes of one repository. */

/** Error message when attempting to mark a prerelease as the latest release. */
export const PRERELEASE_CANNOT_BE_LATEST = "A prerelease cannot be the latest release."
/** The most releases GitHub returns in one page. */
const PAGE_SIZE = 100
/** The most releases scanned when searching for a draft release. */
const MAX_DRAFT_SCAN = 1000

/** Pattern for git release tag names: letters, digits and . _ / + -, no '..' or '//', not ending in '.', '/' or '.lock'. */
export const TAG_PATTERN = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[./]$)[A-Za-z0-9][A-Za-z0-9._\/+-]{0,99}$/

/** Zod schema validating a release tag argument. */
export const releaseTagInput = z
  .string()
  .trim()
  .min(1)
  .regex(TAG_PATTERN, "a tag name: letters, digits and . _ / + -, no '..' or '//', not ending in '.', '/' or '.lock'")
  .describe("The release's git tag, such as v1.2.0.")

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

export async function latestReleaseId(repo: RepoName, ctx: RefContext): Promise<number | null> {
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

/** Returns a `not_found` error for a release that does not exist or is invisible to the viewer. */
export function releaseNotFound(repo: RepoName, tag: string): ToolError {
  return new ToolError("not_found", `Release ${tag} was not found in ${repo.full}, or the viewer cannot see it.`)
}

/**
 * Looks up one release by tag (published or draft), returning null when not found.
 */
export async function findRelease(repo: RepoName, tag: string, ctx: RefContext): Promise<RestRelease | null> {
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

  return raw
}

/**
 * Resolves the commit a release's tag names when it exists, or the commit
 * publishing would tag based on target_commitish (SHA or branch head). Returns
 * commit as null if the tag does not exist and the target branch is gone.
 */
export async function publishCommit(
  repo: RepoName,
  raw: RestRelease,
  ctx: RefContext,
): Promise<{ commit: string | null; tagExists: boolean }> {
  const tagCommitSha = await tagCommit(repo, raw.tag_name, ctx)
  const tagExists = tagCommitSha !== null

  let commit: string | null = null
  if (tagExists) {
    commit = tagCommitSha
  } else if (SHA_PATTERN.test(raw.target_commitish)) {
    commit = raw.target_commitish
  } else {
    commit = await branchHead(repo, raw.target_commitish, ctx)
  }

  return { commit, tagExists }
}

/**
 * Reads one release by tag (published or draft). A missing release throws
 * `not_found`.
 */
export async function readRelease(repo: RepoName, tag: string, ctx: RefContext): Promise<Release> {
  const raw = await findRelease(repo, tag, ctx)
  if (!raw) {
    throw releaseNotFound(repo, tag)
  }

  const latestId = await latestReleaseId(repo, ctx)
  const { commit: commitSha, tagExists } = await publishCommit(repo, raw, ctx)

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

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Validates that target is a 40-hex commit SHA or an existing branch, returning it unchanged. */
export async function resolveTarget(repo: RepoName, target: string, ctx: RefContext): Promise<string> {
  if (SHA_PATTERN.test(target)) return target
  const head = await branchHead(repo, target, ctx)
  if (!head) {
    throw invalid(`${repo.full} has no branch "${target}"; give a branch or a full commit SHA.`)
  }
  return target
}

/** Payload for creating or editing a release via REST. */
export type ReleaseBody = {
  tag_name?: string
  target_commitish?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  generate_release_notes?: boolean
  make_latest?: "true" | "false"
}

async function writeRelease(
  repo: RepoName,
  method: "POST" | "PATCH",
  body: ReleaseBody,
  ctx: RefContext,
  id?: number,
): Promise<RestRelease> {
  const path = `repos/${repo.full}/releases${id === undefined ? "" : `/${id}`}`
  const raw = await refusalAsInvalid(() =>
    ghJson<RestRelease>(["api", "-X", method, path, "--input", "-"], {
      ...ctx,
      stdin: JSON.stringify(body),
    }),
  )
  if (!raw) throw new ToolError("upstream_error", "GitHub did not return the release it wrote.")
  return raw
}

/** Creates a release in a repository. */
export async function createRelease(repo: RepoName, body: ReleaseBody, ctx: RefContext): Promise<RestRelease> {
  return writeRelease(repo, "POST", body, ctx)
}

/** Updates a release by ID; sends tag_name because GitHub drops a draft's tag when an edit leaves tag_name out. */
export async function updateRelease(
  repo: RepoName,
  release: Pick<RestRelease, "id" | "tag_name">,
  body: ReleaseBody,
  ctx: RefContext,
): Promise<RestRelease> {
  return writeRelease(repo, "PATCH", { tag_name: release.tag_name, ...body }, ctx, release.id)
}

/** Deletes a release by ID; GitHub leaves any git tag with the same name. */
export async function deleteRelease(repo: RepoName, id: number, ctx: RefContext): Promise<void> {
  await refusalAsInvalid(() => gh(["api", "-X", "DELETE", `repos/${repo.full}/releases/${id}`], ctx))
}
