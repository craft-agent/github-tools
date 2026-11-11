import { z } from "zod"
import { ToolError, isToolError, type ErrorCode } from "../errors"
import { gh, graphql } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { issueTypes } from "./repository"

/** The prefix of the label that carries an issue's kind where no Issue Type can. */
export const KIND_LABEL_PREFIX = "type:"

/** Where an issue's kind lives: the Issue Type of that name, or the label that stands in for it. */
export const kindPlacementSchema = z.object({ name: z.string(), via: z.enum(["type", "label"]) })

export type KindPlacement = z.output<typeof kindPlacementSchema>

const LABEL_QUERY =
  "query($owner:String!,$name:String!,$label:String!){repository(owner:$owner,name:$name){label(name:$label){id}}}"
/** The codes under which `gh` reports an Issue Type it cannot set. */
const TYPE_FAILURE_CODES: readonly ErrorCode[] = ["upstream_error", "forbidden"]
const TYPE_MENTION = /\btype\b/i
const LABEL_EXISTS = /already[_ ]exists/i

/**
 * An issue's kind, lower-cased: its Issue Type's name, else the suffix of its
 * `type:<kind>` label, else `null`.
 */
export function readKind(issueTypeName: string | null | undefined, labels: readonly string[]): string | null {
  if (issueTypeName) return issueTypeName.toLowerCase()
  for (const label of labels) {
    const kind = label.toLowerCase().startsWith(KIND_LABEL_PREFIX) ? label.slice(KIND_LABEL_PREFIX.length).trim() : ""
    if (kind) return kind.toLowerCase()
  }
  return null
}

/** The label that carries `kind`: `type:` and the kind in lower case. */
export function kindLabel(kind: string): string {
  return `${KIND_LABEL_PREFIX}${kind.toLowerCase()}`
}

/** `kind` placed as its label. */
export function labelKind(kind: string): KindPlacement {
  return { via: "label", name: kindLabel(kind) }
}

/**
 * Where `kind` goes in `repo`: the Issue Type of that name when the owner has
 * one enabled (in GitHub's spelling, matched without regard to case), else
 * the `type:<kind>` label. An empty kind is refused.
 */
export async function resolveKind(kind: string, repo: RepoName, ctx: RefContext): Promise<KindPlacement> {
  const wanted = kind.trim()
  if (!wanted) throw new ToolError("invalid_argument", "kind is empty; give one such as bug or feature.")
  const type = (await issueTypes(repo, ctx)).find((name) => name.toLowerCase() === wanted.toLowerCase())
  return type ? { via: "type", name: type } : labelKind(wanted)
}

/**
 * Makes sure the label exists in `repo`, creating it only when it is missing:
 * `gh label create --force` would overwrite the color of one that exists.
 * Returns whether it was created. A label another call created in between
 * counts as existing.
 */
export async function ensureLabel(repo: RepoName, name: string, ctx: RefContext): Promise<boolean> {
  const data = await graphql<{ repository?: { label?: { id?: string } | null } | null } | null>(
    LABEL_QUERY,
    { owner: repo.owner, name: repo.name, label: name },
    ctx,
  )
  if (data?.repository?.label) return false
  try {
    await gh(["label", "create", name, "--repo", repo.full], ctx)
  } catch (error) {
    if (isToolError(error) && LABEL_EXISTS.test(error.message)) return false
    throw error
  }
  return true
}

/** Whether a failed `gh` call is about the issue type, so the kind can go as a label instead. */
export function isTypeFailure(error: unknown): boolean {
  return isToolError(error) && TYPE_FAILURE_CODES.includes(error.code) && TYPE_MENTION.test(error.message)
}

/**
 * Runs `attempt` with the placement and, when it fails over the Issue Type,
 * once more with the label that stands in for `kind`. Returns the placement
 * that worked and what `attempt` returned.
 */
export async function withKindFallback<T>(
  kind: string,
  placement: KindPlacement,
  attempt: (placement: KindPlacement) => Promise<T>,
): Promise<{ placement: KindPlacement; result: T }> {
  try {
    return { placement, result: await attempt(placement) }
  } catch (error) {
    if (placement.via !== "type" || !isTypeFailure(error)) throw error
    const fallback = labelKind(kind)
    return { placement: fallback, result: await attempt(fallback) }
  }
}

/**
 * The `gh issue edit` flags that put an issue's kind where `placement` says.
 * A label is created first when the repository lacks it.
 */
export async function kindFlags(placement: KindPlacement, repo: RepoName, ctx: RefContext): Promise<string[]> {
  if (placement.via === "type") return ["--type", placement.name]
  await ensureLabel(repo, placement.name, ctx)
  return ["--add-label", placement.name]
}

/** The `type:*` labels among `labels` other than `keep`, which a kind change takes off. */
export function otherKindLabels(labels: readonly string[], keep: string): string[] {
  return labels.filter(
    (label) => label.toLowerCase().startsWith(KIND_LABEL_PREFIX) && label.toLowerCase() !== keep.toLowerCase(),
  )
}
