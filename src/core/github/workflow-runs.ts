import { z } from "zod"
import { ToolError, isToolError, type ErrorCode } from "../errors"
import { gh, ghJson } from "../gh"
import { isGitHubHost, parseRepo, resolveRepo, type RefContext, type RepoName } from "../refs"
import type { FailedJob } from "./pull-requests"
import { refusalAsInvalid } from "./refusal"

/** Lines from the end of each failed job's log a read returns when the caller does not say. */
export const DEFAULT_LOG_LINES = 80
/** The most lines from the end of a log a read may ask for. */
export const MAX_LOG_LINES = 500
const MAX_LOG_JOBS = 3
/** What `gh` prints as the time of a job that has not started. */
const UNSET_TIME_PREFIX = "0001-01-01"
const RUN_ID_PATTERN = /^\d+$/
const RUN_REF_ERROR = "run must be a workflow run id or its URL"
/** The conclusions of a job or a step that count as a failure. */
const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out"]
const RUN_FIELDS = [
  "attempt",
  "conclusion",
  "createdAt",
  "databaseId",
  "displayTitle",
  "event",
  "headBranch",
  "headSha",
  "name",
  "number",
  "startedAt",
  "status",
  "updatedAt",
  "url",
  "workflowDatabaseId",
  "workflowName",
].join(",")
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
export function softFailure(error: unknown): ToolError {
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

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The repository and id a run URL names (`/job/…`, `/attempts/…`, a query or a fragment after the id are ignored), or `undefined` for text that is no such URL. */
export function parseRunUrl(value: string): { repo: RepoName; run: number } | undefined {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || !isGitHubHost(url.hostname)) return undefined
  const [owner, name, actions, runs, id] = url.pathname.split("/").filter(Boolean)
  if (!owner || !name || actions !== "actions" || runs !== "runs" || !id || !isBareRunId(id)) return undefined
  return { repo: parseRepo(`${owner}/${name}`), run: Number.parseInt(id, 10) }
}

/** Whether a reference is a bare workflow run id (`123`), naming no repository of its own. */
export function isBareRunId(value: string): boolean {
  const text = value.trim()
  if (!RUN_ID_PATTERN.test(text)) return false
  const run = Number.parseInt(text, 10)
  return Number.isSafeInteger(run) && run >= 1
}

/**
 * Accepts a workflow run id (`123`; its repository is `repoArg`, else the
 * working tree's) and a run URL `https://<github host>/owner/name/actions/runs/123`
 * with anything after the id. A URL names its own repository, which must agree
 * with `repoArg` when both are given.
 */
export async function parseRunRef(
  value: string,
  repoArg: string | undefined,
  ctx: RefContext,
): Promise<{ repo: RepoName; run: number }> {
  const text = value.trim()
  const fromUrl = parseRunUrl(text)
  if (fromUrl) {
    if (repoArg !== undefined && repoArg.trim() !== "") {
      const other = parseRepo(repoArg)
      if (other.full.toLowerCase() !== fromUrl.repo.full.toLowerCase()) {
        throw invalid(`"${value}" is in ${fromUrl.repo.full}, but repo is ${other.full}; pass one repository.`)
      }
    }
    return fromUrl
  }
  if (!isBareRunId(text)) throw invalid(RUN_REF_ERROR)
  return { repo: await resolveRepo(repoArg, ctx), run: Number.parseInt(text, 10) }
}

/** A workflow run as a list reports it. */
export const runRowSchema = z.object({
  id: z.number().int().describe("The workflow run id."),
  workflow: z.string().describe("The name of the workflow."),
  workflow_id: z.number().int().nullable().describe("The workflow's id; null when GitHub does not report one."),
  title: z.string().describe("The run's title: the commit message, or the pull request title."),
  number: z.number().int().describe("The run's number within its workflow."),
  attempt: z.number().int().describe("Which attempt this is; 1 for a run never re-run."),
  status: z.string().describe("queued, in_progress, waiting, completed, …"),
  conclusion: z.string().nullable().describe("success, failure, cancelled, …; null until the run completes."),
  event: z.string().describe("The event that started the run, such as push or pull_request."),
  branch: z.string().describe("The branch or tag the run is for."),
  head_sha: z.string().describe("The commit the run is for."),
  created_at: z.string(),
  started_at: z.string().nullable(),
  updated_at: z.string(),
  url: z.string().describe("The run's page on GitHub."),
})

export type RunRow = z.output<typeof runRowSchema>

export const runJobSchema = z.object({
  id: z.number().int().describe("The job id."),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  url: z.string().nullable(),
  failed_steps: z.array(z.string()).describe("The names of the steps that failed or timed out."),
})

export type RunJob = z.output<typeof runJobSchema>

/** One workflow run with its jobs. */
export const runDetailSchema = runRowSchema.extend({
  jobs: z.array(runJobSchema),
})

export type RunDetail = z.output<typeof runDetailSchema>

type RawRun = {
  attempt?: number
  conclusion?: string | null
  createdAt: string
  databaseId: number
  displayTitle?: string
  event: string
  headBranch: string
  headSha: string
  name?: string
  number: number
  startedAt?: string | null
  status: string
  updatedAt: string
  url: string
  workflowDatabaseId?: number | null
  workflowName?: string
  jobs?: {
    databaseId: number
    name: string
    status: string
    conclusion?: string | null
    startedAt?: string | null
    completedAt?: string | null
    url?: string | null
    steps?: { name: string; conclusion?: string | null }[]
  }[]
}

/** A time `gh` prints, or `null` for none and for the zero time it prints for a job that has not started. */
function timeOrNull(value: string | null | undefined): string | null {
  return value && !value.startsWith(UNSET_TIME_PREFIX) ? value : null
}

function toRunRow(raw: RawRun): RunRow {
  return {
    id: raw.databaseId,
    workflow: raw.workflowName || raw.name || "",
    workflow_id: raw.workflowDatabaseId ?? null,
    title: raw.displayTitle ?? "",
    number: raw.number,
    attempt: raw.attempt ?? 1,
    status: raw.status,
    conclusion: raw.conclusion || null,
    event: raw.event,
    branch: raw.headBranch,
    head_sha: raw.headSha,
    created_at: raw.createdAt,
    started_at: timeOrNull(raw.startedAt),
    updated_at: raw.updatedAt,
    url: raw.url,
  }
}

function toRunJob(raw: NonNullable<RawRun["jobs"]>[number]): RunJob {
  return {
    id: raw.databaseId,
    name: raw.name,
    status: raw.status,
    conclusion: raw.conclusion || null,
    started_at: timeOrNull(raw.startedAt),
    completed_at: timeOrNull(raw.completedAt),
    url: raw.url || null,
    failed_steps: (raw.steps ?? []).filter((step) => isFailed(step.conclusion)).map((step) => step.name),
  }
}

function isFailed(conclusion: string | null | undefined): boolean {
  return conclusion !== null && conclusion !== undefined && FAILED_CONCLUSIONS.includes(conclusion)
}

export type RunFilters = {
  branch?: string
  /** A workflow's name, file name or id. */
  workflow?: string
  status?: string
  event?: string
  /** A commit SHA. */
  commit?: string
}

/**
 * The repository's latest workflow runs, newest first, narrowed by `filters`.
 * `truncated` is true when more than `limit` matched. A filter on a workflow
 * also finds the runs of a disabled one.
 */
export async function listRuns(
  repo: RepoName,
  filters: RunFilters & { limit: number },
  ctx: RefContext,
): Promise<{ runs: RunRow[]; truncated: boolean }> {
  const args = ["run", "list", "--repo", repo.full, "--limit", String(filters.limit + 1), "--json", RUN_FIELDS]
  if (filters.branch) args.push("--branch", filters.branch)
  if (filters.workflow) args.push("--workflow", filters.workflow, "--all")
  if (filters.status) args.push("--status", filters.status)
  if (filters.event) args.push("--event", filters.event)
  if (filters.commit) args.push("--commit", filters.commit)
  const raw = (await ghJson<RawRun[]>(args, ctx)) ?? []
  return { runs: raw.slice(0, filters.limit).map(toRunRow), truncated: raw.length > filters.limit }
}

/** One workflow run with its jobs, at `attempt` or the latest one. A run that does not exist is `not_found`. */
export async function readRun(
  repo: RepoName,
  id: number,
  attempt: number | undefined,
  ctx: RefContext,
): Promise<RunDetail> {
  const args = ["run", "view", String(id), "--repo", repo.full, "--json", `${RUN_FIELDS},jobs`]
  if (attempt !== undefined) args.push("--attempt", String(attempt))
  let raw: RawRun | null
  try {
    raw = await ghJson<RawRun>(args, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") {
      const which = attempt === undefined ? "" : ` (attempt ${attempt})`
      throw new ToolError(
        "not_found",
        `Workflow run ${id}${which} was not found in ${repo.full}, or the viewer cannot see it.`,
        { cause: error },
      )
    }
    throw error
  }
  if (!raw) throw new ToolError("github_error", `gh returned nothing for workflow run ${id} of ${repo.full}.`)
  return { ...toRunRow(raw), jobs: (raw.jobs ?? []).map(toRunJob) }
}

/** The jobs of a run that failed or timed out, as `readFailedLogs` takes them. */
export function failedJobs(run: RunDetail): FailedJob[] {
  return run.jobs
    .filter((job) => isFailed(job.conclusion))
    .map((job) => ({ name: job.name, job: job.id, url: job.url }))
}

/** Options controlling how a workflow run is re-run. */
export type RerunOptions = {
  failedOnly?: boolean
  job?: number
  debug?: boolean
}

/**
 * Re-runs a workflow run: only failed jobs by default, a specific job, or every job,
 * optionally with debug logging.
 */
export async function rerunRun(repo: RepoName, id: number, options: RerunOptions, ctx: RefContext): Promise<void> {
  const args = ["run", "rerun", String(id), "--repo", repo.full]
  if (options.job !== undefined) {
    args.push("--job", String(options.job))
  } else if (options.failedOnly) {
    args.push("--failed")
  }
  if (options.debug) {
    args.push("--debug")
  }
  await refusalAsInvalid(() => gh(args, ctx))
}

/** Cancels a workflow run that is in progress or queued. */
export async function cancelRun(repo: RepoName, id: number, ctx: RefContext): Promise<void> {
  await refusalAsInvalid(() => gh(["run", "cancel", String(id), "--repo", repo.full], ctx))
}
