import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import { abortError } from "../exec"
import type { PullRequestChecks } from "../github/pull-requests"

const POLL_INTERVAL_MS = 10_000
const MS_PER_SECOND = 1000

export const waitedSchema = z.object({
  seconds: z.number().int().describe("How long the call waited, rounded to whole seconds."),
  polls: z.number().int().describe("How many times the checks were read."),
  ended_by: z
    .enum(["not_waiting", "settled", "failed", "timeout"])
    .describe(
      "not_waiting: read once (wait 0, or the pull request is not open); settled: every check finished; failed: a check failed and fail_fast stopped the wait; timeout: wait ran out.",
    ),
})

export type Waited = z.output<typeof waitedSchema>
type EndedBy = Waited["ended_by"]

export type WaitOptions = {
  /** How long the call may wait, in seconds; 0 reads once. */
  waitSeconds: number
  /** Stop as soon as a check fails. */
  failFast: boolean
  signal?: AbortSignal
}

/** Sleeps, and throws the abort error of `signal` when it aborts meanwhile. */
export async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    throw error
  }
}

/** Why the wait ends on this read, or `undefined` to keep waiting. A pull request with no checks yet is not settled. */
function endOf(current: PullRequestChecks, options: WaitOptions): EndedBy | undefined {
  const { checks, pr } = current
  if (options.waitSeconds === 0 || pr.state !== "open") return "not_waiting"
  if (options.failFast && checks.fail > 0) return "failed"
  if (checks.overall !== "none" && checks.pending === 0) return "settled"
  return undefined
}

/**
 * Reads the checks until they settle. Polls every `POLL_INTERVAL_MS` for at
 * most `waitSeconds`, sleeping no longer than what is left, so the last poll
 * falls on the deadline. A pull request that is not open is read once.
 */
export async function waitForChecks(
  read: () => Promise<PullRequestChecks>,
  options: WaitOptions,
): Promise<{ current: PullRequestChecks; waited: Waited }> {
  const start = Date.now()
  const deadline = start + options.waitSeconds * MS_PER_SECOND
  let polls = 0
  for (;;) {
    const current = await read()
    polls++
    const remaining = deadline - Date.now()
    const endedBy = endOf(current, options) ?? (remaining <= 0 ? "timeout" : undefined)
    if (endedBy) {
      const seconds = Math.round((Date.now() - start) / MS_PER_SECOND)
      return { current, waited: { seconds, polls, ended_by: endedBy } }
    }
    await pause(Math.min(POLL_INTERVAL_MS, remaining), options.signal)
  }
}
