import { setTimeout as sleep } from "node:timers/promises"
import { abortError } from "./exec"

const POLL_INTERVAL_MS = 10_000
const MS_PER_SECOND = 1000

/** How long a read that waits may wait when the caller does not say. */
export const DEFAULT_WAIT_SECONDS = 45
/** The longest a read may wait; hosts stop a tool call after about a minute, so the cap bounds what one call can ask. */
export const MAX_WAIT_SECONDS = 600

export type PollOptions = {
  /** How long the call may wait, in seconds. */
  waitSeconds: number
  signal?: AbortSignal
}

export type Polled<T, E extends string> = {
  current: T
  waited: { seconds: number; polls: number; ended_by: E | "timeout" }
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

/**
 * Reads until `endOf` names a reason to stop. Polls every `POLL_INTERVAL_MS`
 * for at most `waitSeconds`, sleeping no longer than what is left, so the last
 * poll falls on the deadline, where the wait ends as `"timeout"`.
 */
export async function pollUntil<T, E extends string>(
  read: () => Promise<T>,
  endOf: (current: T) => E | undefined,
  options: PollOptions,
): Promise<Polled<T, E>> {
  const start = Date.now()
  const deadline = start + options.waitSeconds * MS_PER_SECOND
  let polls = 0
  for (;;) {
    const current = await read()
    polls++
    const remaining = deadline - Date.now()
    const endedBy = endOf(current) ?? (remaining <= 0 ? "timeout" : undefined)
    if (endedBy) {
      const seconds = Math.round((Date.now() - start) / MS_PER_SECOND)
      return { current, waited: { seconds, polls, ended_by: endedBy } }
    }
    await pause(Math.min(POLL_INTERVAL_MS, remaining), options.signal)
  }
}
