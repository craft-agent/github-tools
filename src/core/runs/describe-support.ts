import { parseRunRef, readRun, type RunDetail } from "../github/workflow-runs"
import type { RepoName } from "../refs"
import type { CallFact, ToolContext } from "../tool"
import { writableContext } from "../write-support"

/** What a description of a run tool reads: the run a call means, found as `execute` finds it. */

/** The statuses a fact shows as a word of the tool's. */
const STATUS_WORDS: Readonly<Record<string, string>> = { queued: "Queued", in_progress: "In progress" }

/**
 * The run `args.run` means, read as `execute` reads it, once the viewer may
 * write to its repository; a run that does not exist is `not_found`. Reads only.
 */
export async function describedRun(
  args: { run: string; repo?: string },
  ctx: ToolContext,
): Promise<{ repo: RepoName; current: RunDetail }> {
  const parsed = await parseRunRef(args.run, args.repo, ctx)
  const { repo } = await writableContext(parsed.repo, ctx)
  return { repo, current: await readRun(repo, parsed.run, undefined, ctx) }
}

/** The `Status` fact of a run: a known status as a template value (`Queued`), any other as it is. */
export function statusFact(status: string): CallFact {
  return { label: "Status", value: Object.hasOwn(STATUS_WORDS, status) ? { text: STATUS_WORDS[status]! } : status }
}
