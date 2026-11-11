import { ToolError, type ErrorCode } from "./errors"
import { abortError, exec, type ExecResult } from "./exec"

/**
 * The highest minimum any tool needs: sub-issue, issue-type and dependency
 * flags arrived in this release.
 */
export const MIN_GH_VERSION = "2.94.0"

/** The release that added `--attach` to `gh pr create`, `gh pr edit` and `gh pr comment`; only a call that attaches needs it. */
export const ATTACH_MIN_GH_VERSION = "2.99.0"

const VERSION_CHECK_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LENGTH = 2000

/** Variables `gh` needs from the caller's environment: its search path, its authentication and its network setup. */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ALL_PROXY",
  "all_proxy",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "PATHEXT",
  "ComSpec",
  "TEMP",
  "TMP",
] as const

/** Settings that keep `gh` from prompting, paging, coloring or announcing updates. */
const FORCED_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GH_PAGER: "cat",
}

/**
 * The variables of `process.env`, read at call time, that a child needs to
 * find its programs, authenticate and reach the network. Nothing else is
 * passed on, so a stray variable cannot redirect a call.
 */
export function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PASSED_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * The environment every `gh` call gets. `GH_REPO` is deliberately not passed:
 * tools resolve the repository themselves, and a stray `GH_REPO` would
 * silently redirect a call.
 */
export function ghEnv(): Record<string, string> {
  return { ...passthroughEnv(), ...FORCED_ENV }
}

export type GhOptions = {
  cwd: string
  signal?: AbortSignal
  /** Text written to `gh`'s stdin, for arguments such as `--body-file -`. */
  stdin?: string
  /** Stops the call after this many milliseconds; defaults to two minutes. */
  timeoutMs?: number
}

/** How long one `gh` call may run before it is stopped. */
export const DEFAULT_GH_TIMEOUT_MS = 120_000

const GH_MISSING_MESSAGE =
  "The GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com."

function isSpawnNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10))
}

function isOlder(version: string, minimum: string): boolean {
  const have = versionParts(version)
  const need = versionParts(minimum)
  for (let i = 0; i < need.length; i++) {
    const difference = (have[i] ?? 0) - need[i]!
    if (difference !== 0) return difference < 0
  }
  return false
}

async function readGhVersion(): Promise<string> {
  let result: ExecResult
  try {
    result = await exec(["gh", "--version"], { env: ghEnv(), timeoutMs: VERSION_CHECK_TIMEOUT_MS })
  } catch (error) {
    if (isSpawnNotFound(error)) throw new ToolError("gh_missing", GH_MISSING_MESSAGE, { cause: error })
    throw error
  }
  const stopped = stoppedError(result, VERSION_CHECK_TIMEOUT_MS)
  if (stopped) throw stopped
  const version = /gh version (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1]
  if (result.code !== 0 || !version) {
    throw new ToolError(
      "upstream_error",
      `Could not read the GitHub CLI version: ${failureText(result.stderr, result.stdout) || `exit ${result.code}`}`,
    )
  }
  if (isOlder(version, MIN_GH_VERSION)) {
    throw new ToolError("gh_too_old", `gh ${version} is older than ${MIN_GH_VERSION}; update the GitHub CLI.`)
  }
  return version
}

let ghCheck: Promise<string> | undefined

/** The installed `gh` version, read once per process; see `ensureGh` for what the read promises. */
async function ghVersion(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError(signal)
  ghCheck ??= readGhVersion().catch((error: unknown) => {
    ghCheck = undefined
    throw error
  })
  return ghCheck
}

/**
 * Checks once per process that `gh` is installed and recent enough. A failed
 * check is not remembered, so a later call retries after the person fixes it.
 * The check itself ignores `signal`, so one caller's abort cannot fail the
 * others waiting on the same check.
 */
export async function ensureGh(signal?: AbortSignal): Promise<void> {
  await ghVersion(signal)
}

/**
 * Checks, on top of `ensureGh`, that `gh` is at least `minimum`, for a call
 * that uses `feature`; older throws `gh_too_old`, naming both versions.
 */
export async function ensureGhAtLeast(minimum: string, feature: string, signal?: AbortSignal): Promise<void> {
  const version = await ghVersion(signal)
  if (isOlder(version, minimum)) {
    throw new ToolError(
      "gh_too_old",
      `${feature} needs gh ${minimum} or newer; this is gh ${version}. Update the GitHub CLI.`,
    )
  }
}

/** Forgets the version check. For tests only, which change `PATH` between cases. */
export function resetGhCheck(): void {
  ghCheck = undefined
}

/** The error for a call that was stopped by a signal, or undefined for one that ran to its end. */
function stoppedError(result: ExecResult, timeoutMs: number): ToolError | undefined {
  if (!result.signal && !result.timedOut) return undefined
  const stoppedBy = result.signal ? ` and was stopped with ${result.signal}` : ""
  const message = result.timedOut
    ? `gh timed out after ${timeoutMs / 1000} seconds${stoppedBy}.`
    : `gh was stopped with ${result.signal}.`
  return new ToolError("upstream_error", message)
}

/**
 * The details of a REST error body `gh api` prints on stdout, such as
 * `{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}`:
 * its `errors` as text (a string, or an object's `message`), else nothing.
 * stderr then says only `gh: Unprocessable Entity (HTTP 422)`.
 */
function restErrorDetails(stdout: string): string[] {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return []
  }
  const errors = typeof body === "object" && body !== null ? (body as { errors?: unknown }).errors : undefined
  if (!Array.isArray(errors)) return []
  return errors.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    const message = typeof entry === "object" && entry !== null ? (entry as { message?: unknown }).message : undefined
    return typeof message === "string" ? [message] : []
  })
}

function failureText(stderr: string, stdout: string): string {
  const details = stderr.trim() ? restErrorDetails(stdout.trim()) : []
  const base = stderr.trim() || stdout.trim()
  const text = details.length ? `${base}: ${details.join("; ")}` : base
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text
}

/** Failure texts of `gh`, in the order they are tried; the first code whose pattern matches wins. */
const FAILURE_PATTERNS = [
  ["unauthenticated", /gh auth login|not logged into|authentication required|http 401/i],
  ["rate_limited", /rate limit|secondary rate|http 429/i],
  ["not_found", /http 404|could not resolve to a|graphql: could not resolve/i],
  ["forbidden", /http 403|resource not accessible|must have[\s\S]*permission|insufficient scopes/i],
  ["stale", /http 409|was modified|is out of date/i],
] as const satisfies readonly (readonly [ErrorCode, RegExp])[]

const FAILURE_HINTS: Partial<Record<ErrorCode, string>> = {
  unauthenticated: "gh is not logged in; run `gh auth login`.",
  rate_limited: "GitHub's rate limit was reached; wait and retry.",
}

/** Maps a failed `gh` call to the error a tool throws. Pure: it reads only its arguments. */
export function classifyGhFailure(stderr: string, stdout: string, code: number): ToolError {
  const text = failureText(stderr, stdout)
  const matched = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "upstream_error"
  const prefix = FAILURE_HINTS[matched] ?? `gh failed (exit ${code}):`
  return new ToolError(matched, text ? `${prefix} ${text}` : prefix)
}

async function runGh(args: string[], options: GhOptions): Promise<ExecResult> {
  await ensureGh(options.signal)
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS
  let result: ExecResult
  try {
    result = await exec(["gh", ...args], {
      cwd: options.cwd,
      env: ghEnv(),
      stdin: options.stdin,
      signal: options.signal,
      timeoutMs,
    })
  } catch (error) {
    if (isSpawnNotFound(error)) throw new ToolError("gh_missing", GH_MISSING_MESSAGE, { cause: error })
    throw error
  }
  const stopped = stoppedError(result, timeoutMs)
  if (stopped) throw stopped
  return result
}

/** A `gh` call that exited non-zero; keeps the stdout it printed, since some commands print what they made before failing. */
export class GhCallError extends ToolError {
  readonly stdout: string

  constructor(failure: ToolError, stdout: string) {
    super(failure.code, failure.message, { cause: failure })
    this.name = "GhCallError"
    this.stdout = stdout
  }
}

/** Runs `gh` with the given arguments and returns its stdout; a failure throws a `GhCallError` of the code `classifyGhFailure` picks. */
export async function gh(args: string[], options: GhOptions): Promise<string> {
  const result = await runGh(args, options)
  if (result.code !== 0) {
    throw new GhCallError(classifyGhFailure(result.stderr, result.stdout, result.code), result.stdout)
  }
  return result.stdout
}

/** `gh`'s stdout parsed as JSON; empty output is `null`. */
export async function ghJson<T>(args: string[], options: GhOptions): Promise<T | null> {
  const text = (await gh(args, options)).trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new ToolError("upstream_error", `gh returned output that is not JSON: ${failureText(text, "")}`, {
      cause: error,
    })
  }
}

/**
 * GraphQL over `gh api graphql`, the one transport the tools share.
 *
 * Variables travel as `-f` (string) / `-F` (typed: number, boolean, null)
 * flags, so a query, its variables and the fake `gh` of the tests all meet on
 * argv. Composite values (lists, input objects) are inlined into the query
 * text with `lit()` instead; GitHub accepts a JSON string as a GraphQL string
 * literal, and enum values stay bare.
 */
export type Vars = Record<string, string | number | boolean | null | undefined>

export type GraphQLErrorEntry = { type?: string; message?: string; [key: string]: unknown }

/** A failure GitHub reported inside a GraphQL reply; keeps the reply's `errors` and whatever `data` came with them. */
export class GraphQLToolError extends ToolError {
  readonly graphqlErrors: GraphQLErrorEntry[]
  readonly data: unknown

  constructor(code: ErrorCode, message: string, graphqlErrors: GraphQLErrorEntry[], data: unknown) {
    super(code, message)
    this.name = "GraphQLToolError"
    this.graphqlErrors = graphqlErrors
    this.data = data
  }
}

const INSUFFICIENT_SCOPES = "INSUFFICIENT_SCOPES"

const GRAPHQL_ERROR_CODES = new Map<string, ErrorCode>([
  ["NOT_FOUND", "not_found"],
  ["FORBIDDEN", "forbidden"],
  [INSUFFICIENT_SCOPES, "forbidden"],
  ["RATE_LIMITED", "rate_limited"],
])

/** What to do about a token that lacks a scope; project boards need the `project` scope (`read:project` to read). */
const SCOPE_HINT =
  "Grant the missing scope with `gh auth refresh -s <scope>`; project boards need `gh auth refresh -s project`."

function varFlags(vars: Vars): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue
    if (typeof value === "string") flags.push("-f", `${key}=${value}`)
    else flags.push("-F", `${key}=${value === null ? "null" : String(value)}`)
  }
  return flags
}

function parseReply(stdout: string): { data?: unknown; errors?: unknown } | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The first error's `type` decides the code; an untyped or unknown one is classified by its message like a `gh` failure. */
function graphqlFailure(errors: GraphQLErrorEntry[], data: unknown): GraphQLToolError {
  const text = failureText(
    errors.map((entry) => (typeof entry.message === "string" ? entry.message : JSON.stringify(entry))).join("; "),
    "",
  )
  const type = errors[0]?.type
  const code = (type === undefined ? undefined : GRAPHQL_ERROR_CODES.get(type)) ?? classifyGhFailure(text, "", 0).code
  const hint = type === INSUFFICIENT_SCOPES ? ` ${SCOPE_HINT}` : ""
  return new GraphQLToolError(code, `${FAILURE_HINTS[code] ?? "GitHub GraphQL error:"} ${text}${hint}`, errors, data)
}

/** Runs one query or mutation and returns its `data`; errors in the reply throw a `GraphQLToolError`. */
export async function graphql<T = unknown>(query: string, vars: Vars, options: Omit<GhOptions, "stdin">): Promise<T> {
  const result = await runGh(["api", "graphql", "-f", `query=${query}`, ...varFlags(vars)], options)
  const reply = parseReply(result.stdout)
  const errors = Array.isArray(reply?.errors) ? (reply.errors as GraphQLErrorEntry[]) : []
  if (errors.length) throw graphqlFailure(errors, reply?.data ?? null)
  if (result.code !== 0) throw classifyGhFailure(result.stderr, result.stdout, result.code)
  return (reply?.data ?? null) as T
}

export type Page<T> = { nodes: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }

const DEFAULT_PAGE_LIMIT = 500

/**
 * Walks a connection whose query declares `$after: String` and passes it as
 * `after: $after`. `pick` returns the connection from one page's data. Stops
 * at `limit` nodes (default 500) so a runaway board cannot pull everything;
 * `truncated` is true when the limit left items out.
 */
export async function paginate<T>(
  query: string,
  vars: Vars,
  pick: (data: any) => Page<T> | null | undefined,
  options: Omit<GhOptions, "stdin"> & { limit?: number },
): Promise<{ items: T[]; truncated: boolean }> {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  const items: T[] = []
  let after: string | null = null
  for (;;) {
    const data: unknown = await graphql(query, { ...vars, after }, options)
    const page = pick(data)
    if (!page) break
    items.push(...(page.nodes ?? []))
    const next = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null
    if (items.length >= limit) return { items: items.slice(0, limit), truncated: items.length > limit || next !== null }
    if (next === null) break
    after = next
  }
  return { items, truncated: false }
}

/** A GraphQL string literal (JSON escaping is valid GraphQL). */
export const lit = (value: string): string => JSON.stringify(value)
