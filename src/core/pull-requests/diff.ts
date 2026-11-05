import { listPullRequestFiles, type ChangedFile } from "../github/pull-request-files"
import { readPullRequestHead, type PullRequestRef } from "../github/pull-requests"
import type { RefContext } from "../refs"

/** The most characters of patch a call returns, so a large pull request cannot fill the caller's context. */
export const PATCH_BUDGET = 60_000
const TRAILING_SLASHES = /\/+$/

export type DiffOptions = {
  /** Keep only files at or under one of these paths; absent or empty keeps every file. */
  paths?: string[]
  patch: boolean
}

/** Whether a file is one of `paths` or lies under one as a directory. */
function isUnder(file: ChangedFile, paths: string[]): boolean {
  return paths.some((path) => file.path === path || file.path.startsWith(`${path}/`))
}

function withinBudget(files: ChangedFile[]): { files: ChangedFile[]; truncated: boolean } {
  let used = 0
  let exhausted = false
  const kept = files.map((file) => {
    if (file.patch === null) return file
    if (!exhausted && used + file.patch.length <= PATCH_BUDGET) {
      used += file.patch.length
      return file
    }
    exhausted = true
    return { ...file, patch: null }
  })
  return { files: kept, truncated: exhausted }
}

/**
 * The files a pull request changes, with their patches within `PATCH_BUDGET`
 * characters in total: from the first file whose patch does not fit, no file
 * keeps its patch.
 */
export async function pullRequestDiff(ref: PullRequestRef, options: DiffOptions, ctx: RefContext) {
  const head = await readPullRequestHead(ref, ctx)
  const listed = await listPullRequestFiles(ref, ctx)
  const paths = (options.paths ?? []).map((path) => path.trim().replace(TRAILING_SLASHES, "")).filter(Boolean)
  const selected = paths.length > 0 ? listed.filter((file) => isUnder(file, paths)) : listed
  const { files, truncated } = options.patch
    ? withinBudget(selected)
    : { files: selected.map((file) => ({ ...file, patch: null })), truncated: false }
  return {
    pr: { number: ref.number, head_sha: head.head_sha },
    files,
    total_files: head.changed_files,
    files_truncated: listed.length < head.changed_files,
    patches_truncated: truncated,
  }
}
