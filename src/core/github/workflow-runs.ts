import { z } from "zod"
import { isToolError, type ErrorCode, type ToolError } from "../errors"
import { gh, ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import type { FailedJob } from "./pull-requests"

const MAX_LOG_JOBS = 3
const MAX_ERROR_LINES = 10
const ERROR_MARKER = "##[error]"
const LOG_FIELD_SEPARATOR = "\t"
/** Fields `gh run view --log-failed` puts before the text of each line: the job name and the step name. */
const LOG_PREFIX_FIELDS = 2
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/
/** Jobs that only summarize the others ("required checks", "all jobs", "ci success"); their log says nothing the failed job's does not. */
const AGGREGATE_JOB_NAME = /^(required|all)[ _-]*(checks?|jobs?)$|^ci[ _-]*(success|ok|status|passed)$/i
/** Failures that would fail every later read as well, so they stop the call instead of being reported per read. */
const HARD_CODES: readonly ErrorCode[] = ["unauthenticated", "rate_limited", "gh_missing", "gh_too_old"]

export const failedLogSchema = z.object({
  name: z.string(),
  job: z.number().int().describe("The GitHub Actions job id."),
  url: z.string().nullable(),
  errors: z.array(z.string()).describe("Lines of the log marked as errors, without the marker."),
  tail: z.string().describe("The last lines of the log."),
  error: z.string().nullable().describe("Why the log could not be read, as code: message; otherwise null."),
})

export type FailedLog = z.output<typeof failedLogSchema>

/** The error of a read that leaves the call usable; a cancellation and a `HARD_CODES` failure are thrown. */
function softFailure(error: unknown): ToolError {
  if (!isToolError(error) || HARD_CODES.includes(error.code)) throw error
  return error
}

function logText(line: string): string {
  const fields = line.split(LOG_FIELD_SEPARATOR)
  const text = fields.length > LOG_PREFIX_FIELDS ? fields.slice(LOG_PREFIX_FIELDS).join(LOG_FIELD_SEPARATOR) : line
  return text.replace(LOG_TIMESTAMP, "")
}

/** The lines marked as errors, and the last `tailLines` non-blank lines, of a failed job's log. */
function digestLog(log: string, tailLines: number): Pick<FailedLog, "errors" | "tail"> {
  const lines = log.split(/\r?\n/).map(logText)
  return {
    errors: lines
      .filter((line) => line.includes(ERROR_MARKER))
      .slice(0, MAX_ERROR_LINES)
      .map((line) => line.replace(ERROR_MARKER, "").trim()),
    tail: lines
      .filter((line) => line.trim() !== "")
      .slice(-tailLines)
      .join("\n"),
  }
}

/** The jobs worth reading: aggregate jobs are dropped when a job of its own failed too, and at most `MAX_LOG_JOBS` remain. */
function selectLogJobs(jobs: FailedJob[]): FailedJob[] {
  const own = jobs.filter((job) => !AGGREGATE_JOB_NAME.test(job.name))
  return (own.length > 0 ? own : jobs).slice(0, MAX_LOG_JOBS)
}

/**
 * The failed steps' logs of the jobs `selectLogJobs` picks, read one after
 * another. A log that cannot be read is reported in its entry and does not
 * fail the call, except for a cancellation and a failure in `HARD_CODES`.
 */
export async function readFailedLogs(
  repo: RepoName,
  jobs: FailedJob[],
  tailLines: number,
  ctx: RefContext,
): Promise<FailedLog[]> {
  const logs: FailedLog[] = []
  for (const job of selectLogJobs(jobs)) {
    const entry = { name: job.name, job: job.job, url: job.url }
    try {
      const log = await gh(["run", "view", "--job", String(job.job), "--log-failed", "--repo", repo.full], ctx)
      logs.push({ ...entry, ...digestLog(log, tailLines), error: null })
    } catch (error) {
      const failure = softFailure(error)
      logs.push({ ...entry, errors: [], tail: "", error: `${failure.code}: ${failure.message}` })
    }
  }
  return logs
}

/**
 * Whether any workflow run exists for a branch; `undefined` when that could
 * not be read, which is not worth failing a call for (a cancellation and a
 * failure in `HARD_CODES` still fail it).
 */
export async function hasWorkflowRun(repo: RepoName, branch: string, ctx: RefContext): Promise<boolean | undefined> {
  try {
    const runs = await ghJson<unknown[]>(
      ["run", "list", "--repo", repo.full, "--branch", branch, "--limit", "1", "--json", "databaseId"],
      ctx,
    )
    return Array.isArray(runs) ? runs.length > 0 : undefined
  } catch (error) {
    softFailure(error)
    return undefined
  }
}
