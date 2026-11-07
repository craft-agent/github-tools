import { z } from "zod"
import type { PullRequestChecks } from "../github/pull-requests"
import { pollUntil } from "../poll"

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

/** Why the wait ends on this read, or `undefined` to keep waiting. A pull request with no checks yet is not settled. */
function endOf(current: PullRequestChecks, options: WaitOptions): Exclude<EndedBy, "timeout"> | undefined {
  const { checks, pr } = current
  if (options.waitSeconds === 0 || pr.state !== "open") return "not_waiting"
  if (options.failFast && checks.fail > 0) return "failed"
  if (checks.overall !== "none" && checks.pending === 0) return "settled"
  return undefined
}

/**
 * Reads the checks until they settle, polling as `pollUntil` does for at most
 * `waitSeconds`. A pull request that is not open is read once.
 */
export async function waitForChecks(
  read: () => Promise<PullRequestChecks>,
  options: WaitOptions,
): Promise<{ current: PullRequestChecks; waited: Waited }> {
  return pollUntil(read, (current) => endOf(current, options), {
    waitSeconds: options.waitSeconds,
    signal: options.signal,
  })
}
