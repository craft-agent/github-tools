import { z } from "zod"
import { isAbortError } from "../errors"
import { gh, ghJson } from "../gh"
import { branchHead, defaultBranch } from "../github/branches"
import type { RepoName } from "../refs"
import type { ToolContext } from "../tool"

/** Deleting the head branches of merged pull requests, which never fails the merge it follows. */

export const branchOutcomeSchema = z.object({
  name: z.string().describe("The head branch."),
  result: z
    .enum(["deleted", "kept", "already_gone", "not_deleted"])
    .describe("kept: left on purpose, see reason; not_deleted: the delete failed, see reason."),
  reason: z.string().nullable().describe("Why it was kept or not deleted; null otherwise."),
})

export type BranchOutcome = z.output<typeof branchOutcomeSchema>

/** A head branch of a merged pull request, with the commit that was merged. */
export type BranchTarget = {
  name: string
  head_sha: string
  /** Whether the branch is in a fork, not in the repository. */
  cross_repository: boolean
}

const refPath = (branch: string): string => branch.split("/").map(encodeURIComponent).join("/")

const kept = (name: string, reason: string): BranchOutcome => ({ name, result: "kept", reason })

/** The number of an open pull request into `branch`, if there is one. */
async function openPullRequestInto(repo: RepoName, branch: string, ctx: ToolContext): Promise<number | undefined> {
  const open = await ghJson<{ number: number }[]>(
    ["pr", "list", "--repo", repo.full, "--base", branch, "--state", "open", "--json", "number", "--limit", "1"],
    { cwd: ctx.cwd, signal: ctx.signal },
  )
  return open?.[0]?.number
}

async function tidyBranch(
  repo: RepoName,
  target: BranchTarget,
  trunk: () => Promise<string | null>,
  ctx: ToolContext,
): Promise<BranchOutcome> {
  const { name } = target
  try {
    if (target.cross_repository) return kept(name, "it is in a fork")
    if (name === (await trunk())) return kept(name, "it is the default branch")
    const dependent = await openPullRequestInto(repo, name, ctx)
    if (dependent !== undefined) return kept(name, `#${dependent} is based on it`)
    const head = await branchHead(repo, name, ctx)
    if (head === null) return { name, result: "already_gone", reason: null }
    if (head.toLowerCase() !== target.head_sha.toLowerCase()) return kept(name, "it has new commits")
    // REST has no conditional delete: a push between the read above and this call is lost with the branch.
    await gh(["api", "-X", "DELETE", `repos/${repo.full}/git/refs/heads/${refPath(name)}`], {
      cwd: ctx.cwd,
      signal: ctx.signal,
    })
    return { name, result: "deleted", reason: null }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { name, result: "not_deleted", reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Deletes the branches in the order given, each on its own: the repository's
 * default branch, a branch an open pull request is based on, one in a fork, and
 * one that moved since the merge are kept; one already gone is reported so. A
 * failure is reported as `not_deleted` and never thrown, except a cancellation.
 */
export async function tidyBranches(
  repo: RepoName,
  targets: readonly BranchTarget[],
  ctx: ToolContext,
): Promise<BranchOutcome[]> {
  let trunk: Promise<string | null> | undefined
  const defaultOf = () => (trunk ??= defaultBranch(repo, ctx))
  const outcomes: BranchOutcome[] = []
  for (const target of targets) outcomes.push(await tidyBranch(repo, target, defaultOf, ctx))
  return outcomes
}
