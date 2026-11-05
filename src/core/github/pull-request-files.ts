import { z } from "zod"
import { ghJson } from "../gh"
import type { RefContext } from "../refs"
import type { PullRequestRef } from "./pull-requests"

const FILES_PAGE_SIZE = 100
/** GitHub lists at most 3000 files of a pull request. */
const MAX_FILE_PAGES = 30

export const changedFileSchema = z.object({
  path: z.string(),
  status: z.string().describe("As GitHub gives it: added, removed, modified, renamed, copied, changed or unchanged."),
  previous_path: z.string().nullable().describe("The path before a rename or copy; otherwise null."),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z
    .string()
    .nullable()
    .describe("The file's unified diff; null for a binary or very large file, or when it is left out."),
})

export type ChangedFile = z.output<typeof changedFileSchema>

type RawFile = {
  filename: string
  status: string
  previous_filename?: string | null
  additions: number
  deletions: number
  patch?: string | null
}

/** The files a pull request changes, in GitHub's order, at most 3000. */
export async function listPullRequestFiles(ref: PullRequestRef, ctx: RefContext): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const raw =
      (await ghJson<RawFile[]>(
        ["api", `repos/${ref.repo.full}/pulls/${ref.number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`],
        ctx,
      )) ?? []
    for (const file of raw) {
      files.push({
        path: file.filename,
        status: file.status,
        previous_path: file.previous_filename ?? null,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
      })
    }
    if (raw.length < FILES_PAGE_SIZE) break
  }
  return files
}
