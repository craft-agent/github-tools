import { readPullRequestChecks, type PullRequestRef } from "../github/pull-requests"
import { hasWorkflowRun, readFailedLogs } from "../github/workflow-runs"
import type { RefContext } from "../refs"
import { waitForChecks } from "./wait"

const NO_WORKFLOW_RUN_HINT =
  "No workflow run exists for this branch: the repository may have no CI for it, or a run is waiting for approval."
const STILL_RUNNING_HINT = "The checks are still running; call again to keep waiting."
const TRUNCATED_HINT = "The pull request has more than 100 checks; only the first 100 were read."

export type ChecksOptions = {
  /** Seconds the call may wait for the checks to settle; 0 reads once. */
  wait: number
  failFast: boolean
  /** Lines from the end of each failed job's log; 0 reads no logs. */
  logLines: number
}

/**
 * A pull request's checks, waiting up to `options.wait` seconds for them to
 * settle, with the end of the log of each failed Actions job and hints for what
 * a caller does next.
 */
export async function pullRequestChecks(ref: PullRequestRef, options: ChecksOptions, ctx: RefContext) {
  const { current, waited } = await waitForChecks(() => readPullRequestChecks(ref, ctx), {
    waitSeconds: options.wait,
    failFast: options.failFast,
    signal: ctx.signal,
  })
  const { pr, checks } = current
  const failedLogs =
    options.logLines > 0 ? await readFailedLogs(ref.repo, current.failed_jobs, options.logLines, ctx) : []

  const hints: string[] = []
  if (checks.overall === "none" && pr.state === "open" && (await hasWorkflowRun(ref.repo, pr.head, ctx)) === false) {
    hints.push(NO_WORKFLOW_RUN_HINT)
  }
  if (checks.overall === "pending" && waited.ended_by === "timeout") hints.push(STILL_RUNNING_HINT)
  if (checks.truncated) hints.push(TRUNCATED_HINT)

  return { pr, checks, check_runs: current.check_runs, failed_logs: failedLogs, waited, hints }
}
