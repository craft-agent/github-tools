import { ToolError, type ErrorCode } from "./errors"

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

function failureText(stderr: string, stdout: string): string {
  const text = stderr.trim() || stdout.trim()
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
  const matched = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "github_error"
  const prefix = FAILURE_HINTS[matched] ?? `gh failed (exit ${code}):`
  return new ToolError(matched, text ? `${prefix} ${text}` : prefix)
}
