import { z } from "zod"
import { ToolError } from "../errors"
import { gh, ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { refusalAsInvalid } from "./refusal"
import { readRepositoryPages } from "./repos"

/** The most labels read while looking for a name; a repository with more is reported as truncated. */
const MAX_LABELS_SCANNED = 5000

export const labelSchema = z.object({
  name: z.string(),
  color: z.string().describe("The color as six hex digits, without #."),
  description: z.string().describe("Empty when there is none."),
})

export type Label = z.output<typeof labelSchema>

type RawLabel = { name: string; color: string; description?: string | null }

const LABELS_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    labels(first:100,after:$after,orderBy:{field:NAME,direction:ASC}){ nodes{name color description} pageInfo{hasNextPage endCursor} }
  }
}`

/**
 * The repository's labels by name. With `search`, only those whose name holds
 * it without regard to case, found by reading the labels one page at a time
 * (GitHub's own search matches whole words and descriptions, not parts of a
 * name). At most `limit`; `truncated` says more matched, or that the scan
 * stopped before the last label.
 */
export async function listLabels(
  repo: RepoName,
  options: { search?: string; limit: number },
  ctx: RefContext,
): Promise<{ labels: Label[]; truncated: boolean }> {
  const search = options.search?.toLowerCase()
  const { items, truncated } = await readRepositoryPages<RawLabel>(
    repo,
    LABELS_QUERY,
    (repository) => repository.labels,
    { ...ctx, limit: search === undefined ? options.limit : MAX_LABELS_SCANNED },
  )
  const matching = search === undefined ? items : items.filter((label) => label.name.toLowerCase().includes(search))
  return {
    labels: matching
      .slice(0, options.limit)
      .map((label) => ({ name: label.name, color: label.color, description: label.description ?? "" })),
    truncated: truncated || matching.length > options.limit,
  }
}

export const labelNameInput = z.string().trim().min(1).describe("The label's name, matched without regard to case.")
export const labelColorInput = z
  .string()
  .regex(/^#?[0-9a-f]{6}$/i)
  .describe("Six hex digits, with or without #.")

export async function labelsForWrite(repo: RepoName, ctx: RefContext): Promise<Label[]> {
  return (await listLabels(repo, { limit: Number.MAX_SAFE_INTEGER }, ctx)).labels
}

export function findLabel(labels: Label[], name: string): Label {
  const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase())
  if (!found) throw new ToolError("not_found", `Label "${name}" was not found.`)
  return found
}

export type LabelBody = Partial<Label> & { new_name?: string }

export async function writeLabel(
  repo: RepoName,
  method: "POST" | "PATCH",
  body: LabelBody,
  ctx: RefContext,
  name?: string,
): Promise<{ label: Label }> {
  const path = `repos/${repo.full}/labels${name === undefined ? "" : `/${encodeURIComponent(name)}`}`
  const raw = await refusalAsInvalid(() =>
    ghJson<RawLabel>(["api", "-X", method, path, "--input", "-"], {
      ...ctx,
      stdin: JSON.stringify(body),
    }),
  )
  if (!raw) throw new ToolError("upstream_error", "GitHub did not return the label it wrote.")
  return {
    label: { name: raw.name, color: raw.color, description: raw.description ?? "" },
  }
}

export async function deleteLabel(repo: RepoName, name: string, ctx: RefContext): Promise<void> {
  await refusalAsInvalid(() =>
    gh(["api", "-X", "DELETE", `repos/${repo.full}/labels/${encodeURIComponent(name)}`], ctx),
  )
}
