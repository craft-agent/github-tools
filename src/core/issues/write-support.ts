import { gh } from "../gh"
import { readIssueHeading, type IssueHeading } from "../github/issues"
import { kindFlags, withKindFallback, type KindPlacement } from "../github/kind"
import { parseNumberRef, type RepoName } from "../refs"
import type { TargetKind, ToolContext } from "../tool"

/** What the issue write tools share: `gh issue edit`, the kind, the issue argument. */

export const ISSUE_DESCRIPTION = "The issue, as 12, #12, owner/repo#12 or its URL."

/** The targets of a tool that writes to one issue, named by `issue` and `repo`. */
export const ISSUE_TARGETS = { issue: "issue", repo: "repo" } as const satisfies Readonly<Record<string, TargetKind>>

/** The issue an `issue` and `repo` argument name, resolved as `execute` does, with its heading read from GitHub. */
export async function describedIssue(
  args: { issue: string; repo?: string },
  ctx: ToolContext,
): Promise<{ ref: { repo: RepoName; number: number }; heading: IssueHeading }> {
  const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
  return { ref, heading: await readIssueHeading(ref, ctx) }
}

/** Runs `gh issue edit` on one issue of `repo` with the given flags; `stdin` is the body for `--body-file -`. */
export function editIssue(
  repo: RepoName,
  number: number,
  flags: string[],
  ctx: ToolContext,
  stdin?: string,
): Promise<string> {
  return gh(["issue", "edit", String(number), "--repo", repo.full, ...flags], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    stdin,
  })
}

/** Puts an issue's kind where `placement` says, falling back to the label when GitHub refuses the Issue Type; returns where it landed. */
export async function setKind(
  kind: string,
  placement: KindPlacement,
  target: RepoName,
  number: number,
  ctx: ToolContext,
): Promise<KindPlacement> {
  const applied = await withKindFallback(kind, placement, async (where) =>
    editIssue(target, number, await kindFlags(where, target, ctx), ctx),
  )
  return applied.placement
}
