import { isAbortError } from "../errors"
import { GhCallError, gh } from "../gh"
import { resolveRelatedIssue, type IssueRef } from "../github/issue-refs"
import {
  readPullRequestState,
  type ClosingIssue,
  type PullRequestRef,
  type PullRequestState,
} from "../github/pull-requests"
import { given, lastUrl } from "../issues/write-support"
import type { RepoName } from "../refs"
import type { StepErrors, TargetKind, ToolContext } from "../tool"
import { issueKey } from "./closes"
import { pause } from "./wait"

/** What the pull request write tools share: their reference argument, `gh pr edit` and the notes about closing issues. */

export const PR_DESCRIPTION = "The pull request, as 12, #12, owner/repo#12 or its URL."

/** The targets of a tool that writes to one pull request, named by `pr` and `repo`. */
export const PR_TARGETS = { pr: "pull", repo: "repo" } as const satisfies Readonly<Record<string, TargetKind>>

/** Runs `gh pr edit` on one pull request of `repo` with the given flags; `stdin` is the body for `--body-file -`. */
export function editPullRequest(
  repo: RepoName,
  number: number,
  flags: string[],
  ctx: ToolContext,
  stdin?: string,
): Promise<string> {
  return gh(["pr", "edit", String(number), "--repo", repo.full, ...flags], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    stdin,
  })
}

/** The step under `errors` that names a failed upload. */
export const ATTACHMENTS_STEP = "attachments"

/**
 * The failure of a `gh` call that attached files and still printed a URL: some
 * uploads failed, and `gh` made or changed the pull request (or comment)
 * with the others. `undefined` for any other failure.
 */
export function partialUpload(error: unknown): GhCallError | undefined {
  return error instanceof GhCallError && lastUrl(error.stdout) !== undefined ? error : undefined
}

/**
 * Runs a `gh` call that may carry attachments and returns its stdout. A partial
 * upload does not fail the call: it is recorded under `errors.attachments` of
 * `steps` and the stdout `gh` printed is returned.
 */
export async function settleUpload(call: () => Promise<string>, attached: boolean, steps: StepErrors): Promise<string> {
  if (!attached) return call()
  try {
    return await call()
  } catch (error) {
    const partial = partialUpload(error)
    if (!partial) throw error
    await steps.record(ATTACHMENTS_STEP, async () => {
      throw partial
    })
    return partial.stdout
  }
}

/** The issues a list argument names, without blanks or repeats; a bare number means the pull request's repository. No call to GitHub is made. */
export async function resolveClosing(
  values: readonly string[] | undefined,
  prRepo: RepoName,
  ctx: ToolContext,
): Promise<IssueRef[]> {
  const issues = new Map<string, IssueRef>()
  for (const value of values ?? []) {
    const ref = given(value)
    if (!ref) continue
    const issue = await resolveRelatedIssue(ref, prRepo, ctx)
    issues.set(issueKey(issue.repo.full, issue.number), issue)
  }
  return [...issues.values()]
}

/** How often the closing issues are read again after a write, and for how long. */
export const CLOSING_POLL_INTERVAL_MS = 1000
export const CLOSING_POLL_TIMEOUT_MS = 6000

/** The closing issues a write asked for: to link, and to stop linking. */
export type ClosingChange = {
  add: readonly IssueRef[]
  remove: readonly IssueRef[]
}

const linkedKeys = (linked: readonly ClosingIssue[]): Set<string> =>
  new Set(linked.map((issue) => issueKey(issue.repo, issue.number)))

/** Whether GitHub links every issue asked for and none asked to go. */
function isSettled(linked: readonly ClosingIssue[], change: ClosingChange): boolean {
  const keys = linkedKeys(linked)
  return (
    change.add.every((issue) => keys.has(issueKey(issue.repo.full, issue.number))) &&
    change.remove.every((issue) => !keys.has(issueKey(issue.repo.full, issue.number)))
  )
}

/**
 * The pull request's state once GitHub has linked the closing issues a write
 * asked for, which it does a moment after the write. Starts from `first`, the
 * read made right after the write, and reads again every
 * `CLOSING_POLL_INTERVAL_MS` until every issue to add is linked and every one to
 * remove is gone, or `CLOSING_POLL_TIMEOUT_MS` have passed; the last read wins.
 * A read that fails ends the wait with the last state read. A pull request into
 * a branch other than the default one links nothing, so it is not waited for.
 */
export async function settledClosingState(
  first: PullRequestState,
  change: ClosingChange,
  options: { pull: PullRequestRef; defaultBranch: string | null },
  ctx: ToolContext,
): Promise<PullRequestState> {
  if (options.defaultBranch === null || first.base !== options.defaultBranch) return first
  const deadline = Date.now() + CLOSING_POLL_TIMEOUT_MS
  let state = first
  while (!isSettled(state.closing_issues, change)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await pause(Math.min(CLOSING_POLL_INTERVAL_MS, remaining), ctx.signal)
    try {
      state = await readPullRequestState(options.pull, ctx)
    } catch (error) {
      if (isAbortError(error)) throw error
      break
    }
  }
  return state
}

/** What the notes after a write that touched closing issues are drawn from. */
export type ClosingState = ClosingChange & {
  /** The pull request's base branch. */
  base: string
  /** The repository's default branch; `null` when it has none. */
  defaultBranch: string | null
  /** The issues GitHub links as closed by the pull request, as last read; `undefined` when they could not be read. */
  linked: readonly ClosingIssue[] | undefined
}

/**
 * What to tell the caller about the closing issues of a pull request after a
 * write that touched them: that GitHub links them only for a pull request into
 * the default branch, which issue asked for is not linked yet, and which issue
 * asked to go is still linked.
 */
export function closingNotes(state: ClosingState): string[] {
  const notes: string[] = []
  const intoOtherBranch = state.defaultBranch !== null && state.defaultBranch !== state.base
  if (intoOtherBranch && state.add.length > 0) {
    notes.push(
      `GitHub links closing issues only for a pull request into the default branch (${state.defaultBranch}); this one is into ${state.base}, so the issues are named in the body but not linked.`,
    )
  }
  if (!state.linked) return notes
  const linked = linkedKeys(state.linked)
  if (!intoOtherBranch) {
    for (const issue of state.add) {
      if (!linked.has(issueKey(issue.repo.full, issue.number))) {
        notes.push(
          `GitHub had not linked ${issue.repo.full}#${issue.number} yet when this call returned; github_pr_read view shows it once it does.`,
        )
      }
    }
  }
  for (const issue of state.remove) {
    if (linked.has(issueKey(issue.repo.full, issue.number))) {
      notes.push(
        `${issue.repo.full}#${issue.number} is still linked: the body or a commit message mentions it in another form.`,
      )
    }
  }
  return notes
}
