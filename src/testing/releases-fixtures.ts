import { encodePathSegments } from "../core/github/branches"
import type { GhRule } from "./fake-gh"
import { restFailure, restPaths } from "./repos-fixtures"

export { restFailure, restPaths }

export const RELEASE_COMMIT = "c3d0be41ecbe669545ee3e94d31ed9a4bc91ee3c"

type Extra = Record<string, unknown>

function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function pathPattern(prefix: string, value: string): string {
  return `${prefix}/${escapeRegex(encodePathSegments(value))}`
}

/** A call `gh api` reports as HTTP 404 Not Found. */
export const restNotFound = (match: string, body: Extra = {}): GhRule =>
  restFailure(match, "Not Found (HTTP 404)", body)

/** The raw REST release as GitHub returns it. */
export const rawRelease = (tag: string, extra: Extra = {}) => ({
  id: 101,
  tag_name: tag,
  name: `Release ${tag}`,
  body: `Notes for ${tag}`,
  draft: false,
  prerelease: false,
  created_at: "2026-11-06T12:00:00Z",
  published_at: "2026-11-06T12:30:00Z",
  html_url: `https://github.com/octo/hello/releases/tag/${tag}`,
  target_commitish: "main",
  immutable: false,
  updated_at: "2026-11-06T12:30:00Z",
  author: { login: "alice" },
  assets: [],
  ...extra,
})

/** A release row as expected from list. */
export const expectedReleaseRow = (tag: string, extra: Extra = {}) => ({
  tag,
  title: `Release ${tag}`,
  draft: false,
  prerelease: false,
  latest: false,
  created_at: "2026-11-06T12:00:00Z",
  published_at: "2026-11-06T12:30:00Z",
  ...extra,
})

/** A release as expected from view. */
export const expectedRelease = (tag: string, extra: Extra = {}) => ({
  ...expectedReleaseRow(tag),
  url: `https://github.com/octo/hello/releases/tag/${tag}`,
  notes: `Notes for ${tag}`,
  author: "alice",
  target: "main",
  tag_exists: true,
  commit: RELEASE_COMMIT,
  immutable: false,
  updated_at: "2026-11-06T12:30:00Z",
  assets: [],
  ...extra,
})

/** A rule matching the releases list endpoint for a given page. */
export const releasesPageRule = (page: number, releases: unknown[], times?: number): GhRule => ({
  match: `releases\\?per_page=100&page=${page}`,
  stdout: JSON.stringify(releases),
  times,
})

/** A rule matching the releases/latest endpoint. */
export const releasesLatestRule = (release: unknown, times?: number): GhRule => ({
  match: "releases/latest",
  stdout: JSON.stringify(release),
  times,
})

/** A rule matching the releases/tags/{tag} endpoint. */
export const releaseByTagRule = (tag: string, release: unknown, times?: number): GhRule => ({
  match: pathPattern("releases/tags", tag),
  stdout: JSON.stringify(release),
  times,
})

/** A rule matching the git/ref/tags/{tag} endpoint. */
export const gitRefTagRule = (tag: string, ref: unknown, times?: number): GhRule => ({
  match: pathPattern("git/ref/tags", tag),
  stdout: JSON.stringify(ref),
  times,
})

/** A rule matching the git/tags/{sha} endpoint. */
export const gitTagRule = (sha: string, tagObj: unknown, times?: number): GhRule => ({
  match: `git/tags/${sha}`,
  stdout: JSON.stringify(tagObj),
  times,
})

/** A rule matching the branches/{branch} endpoint. */
export const branchRule = (branch: string, sha: string, times?: number): GhRule => ({
  match: pathPattern("branches", branch),
  stdout: JSON.stringify({ commit: { sha } }),
  times,
})
