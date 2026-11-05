import { ToolError } from "../errors"
import { gh } from "../gh"
import { kindFlags, withKindFallback, type KindPlacement } from "../github/kind"
import { assertWritable, repositoryContext, type RepositoryContext } from "../github/repository"
import type { RepoName } from "../refs"
import type { TargetKind, ToolContext } from "../tool"

/** What the issue write tools share: argument checks, the permission gate and `gh issue edit`. */

export const REPO_DESCRIPTION =
  "owner/name; defaults to the working tree's repository (its origin). Used for a bare number."
export const ISSUE_DESCRIPTION = "The issue, as 12, #12, owner/repo#12 or its URL."

/** The targets of a tool that writes to one issue, named by `issue` and `repo`. */
export const ISSUE_TARGETS = { issue: "issue", repo: "repo" } as const satisfies Readonly<Record<string, TargetKind>>

/** `gh` reads `--label` and `--assignee` values as CSV: a comma splits one name into two, and a quote or a line break is syntax. */
const LIST_SYNTAX = /[,"\r\n]/
const URL_LINE = /^https?:\/\/\S+$/
const BODY_SEPARATOR = "\n\n"

export function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** An argument's text with its surrounding space removed; blank counts as not given. */
export function given(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** The names of a list argument, trimmed and without blanks or repeats; a name `gh` would split is refused. */
export function nameList(argument: string, values: readonly string[] | undefined): string[] {
  const names = new Set<string>()
  for (const value of values ?? []) {
    const name = value.trim()
    if (LIST_SYNTAX.test(name)) {
      throw invalid(
        `${argument}: ${JSON.stringify(name)} contains a comma, a double quote or a line break, which gh reads as list syntax.`,
      )
    }
    if (name) names.add(name)
  }
  return [...names]
}

/** The permission gate every write passes before it changes anything: the repository's context, once the viewer may write there. */
export async function writableContext(repo: RepoName, ctx: ToolContext): Promise<RepositoryContext> {
  const context = await repositoryContext(repo, ctx)
  assertWritable(context)
  return context
}

/** The last line of `stdout` that is a URL, which is where `gh` prints what it made or changed. */
export function lastUrl(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => URL_LINE.test(line))
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

/** `current` and `added` apart by a blank line; an empty body takes the text alone. */
export function appended(current: string, added: string): string {
  const body = current.trimEnd()
  return body ? `${body}${BODY_SEPARATOR}${added}` : added
}
