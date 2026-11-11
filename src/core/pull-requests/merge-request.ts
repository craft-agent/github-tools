import { ToolError, isAbortError, isToolError } from "../errors"
import { ghJson } from "../gh"
import type { MergeMethod } from "../github/pull-requests"
import { STACK_API_VERSION } from "../github/stacks"
import { pause } from "../poll"
import type { RepoName } from "../refs"
import type { ToolContext } from "../tool"

/** GitHub's asynchronous merge endpoint: one request for every pull request, stacked or not, and the wait for its answer. */

/** How often a pending merge request is read again, and for how long. */
export const MERGE_POLL_INTERVAL_MS = 3000
export const MERGE_POLL_TIMEOUT_MS = 45_000

export const MERGE_STATUSES = ["pending", "merged", "enqueued", "failed"] as const
export type MergeStatus = (typeof MERGE_STATUSES)[number]

/** The merge endpoints exist only under the dated API version the stack calls use. */
const VERSION_HEADER = ["-H", `X-GitHub-Api-Version: ${STACK_API_VERSION}`]

/** What the body of a merge request holds; `bypass_rules` and `merge_action` are never sent. */
export type MergeRequestBody = {
  merge_method: MergeMethod
  /** The head commit the caller saw; GitHub refuses the merge when the head moved. */
  sha: string
  commit_title?: string
  commit_message?: string
}

type RawMergeReply = { status?: string; details?: { message?: string; uuid?: string } }

/** Where a merge request stands, as GitHub last said. */
export type MergeProgress = {
  status: MergeStatus
  /** GitHub's message: why the merge failed, or what it is doing. */
  message: string | null
  /** The request's ID, which `merge-async/<uuid>` answers for; `null` when GitHub gave none. */
  uuid: string | null
}

/** A merge request followed to where it ended or the wait did. */
export type MergeOutcome = MergeProgress & {
  /** Why polling stopped on a failure other than an expired request; `null` when it did not. */
  poll_error: string | null
}

export type MergeTiming = { intervalMs: number; timeoutMs: number }

const DEFAULT_TIMING: MergeTiming = { intervalMs: MERGE_POLL_INTERVAL_MS, timeoutMs: MERGE_POLL_TIMEOUT_MS }

function progressOf(reply: RawMergeReply | null, fallbackUuid: string | null = null): MergeProgress {
  const status = MERGE_STATUSES.find((known) => known === reply?.status)
  if (!reply || !status) {
    throw new ToolError(
      "upstream_error",
      `GitHub answered the merge request with ${reply?.status ? `the status ${reply.status}` : "nothing"}, which this tool does not know.`,
    )
  }
  return { status, message: reply.details?.message ?? null, uuid: reply.details?.uuid ?? fallbackUuid }
}

/** Sends the merge request. A 409, another merge of the pull request running, is `stale` as the runner maps it. */
export async function startMerge(
  repo: RepoName,
  number: number,
  body: MergeRequestBody,
  ctx: ToolContext,
): Promise<MergeProgress> {
  const reply = await ghJson<RawMergeReply>(
    ["api", "-X", "PUT", ...VERSION_HEADER, `repos/${repo.full}/pulls/${number}/merge-async`, "--input", "-"],
    { cwd: ctx.cwd, signal: ctx.signal, stdin: JSON.stringify(body) },
  )
  return progressOf(reply)
}

/**
 * Follows a merge request from `first`, reading it at once and then every
 * `intervalMs`, until it is merged, enqueued or failed, or `timeoutMs` have
 * passed (the last read stays `pending`). An expired request (404) ends the
 * wait without an error: the caller reads the pull requests to see what
 * happened. Any other failure of a read ends it too, with `poll_error` set, so
 * a merge GitHub accepted is never lost to a failed read.
 */
export async function followMerge(
  repo: RepoName,
  number: number,
  first: MergeProgress,
  ctx: ToolContext,
  timing: MergeTiming = DEFAULT_TIMING,
): Promise<MergeOutcome> {
  const { uuid } = first
  let progress = first
  let pollError: string | null = null
  if (first.status === "pending" && uuid) {
    const deadline = Date.now() + timing.timeoutMs
    for (;;) {
      try {
        progress = progressOf(
          await ghJson<RawMergeReply>(
            ["api", ...VERSION_HEADER, `repos/${repo.full}/pulls/${number}/merge-async/${uuid}`],
            { cwd: ctx.cwd, signal: ctx.signal },
          ),
          uuid,
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        if (!(isToolError(error) && error.code === "not_found")) {
          pollError = error instanceof Error ? error.message : String(error)
        }
        break
      }
      const remaining = deadline - Date.now()
      if (progress.status !== "pending" || remaining <= 0) break
      await pause(Math.min(timing.intervalMs, remaining), ctx.signal)
    }
  }
  return { ...progress, poll_error: pollError }
}
