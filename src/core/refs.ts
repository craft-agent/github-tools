import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import { ToolError } from "./errors"
import { exec, type ExecResult } from "./exec"
import { passthroughEnv } from "./gh"
import type { ToolContext } from "./tool"

export type RepoName = { owner: string; name: string; full: string }

export type RefContext = Pick<ToolContext, "cwd" | "signal" | "ownDir">

const DEFAULT_HOST = "github.com"
/** GitHub's SSH-over-443 endpoint, which serves the repositories of `github.com`. */
const SSH_ALIAS_HOST = "ssh.github.com"
const GIT_CONFIG_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const
/** Enterprise Managed User logins contain `_`. */
export const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const REPO_PATTERN = /^([^/\s#]+)\/([^/\s#]+)$/
const QUALIFIED_NUMBER_PATTERN = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/
const BARE_NUMBER_PATTERN = /^#?(\d+)$/
const SCP_PATTERN = /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s][^\s]*)$/
const GIT_SUFFIX = /\.git$/

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

export function isGitHubHost(host: string): boolean {
  const known = host.toLowerCase()
  return known === DEFAULT_HOST || (process.env.GH_HOST !== undefined && known === process.env.GH_HOST.toLowerCase())
}

function repoName(owner: string, name: string): RepoName | undefined {
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === "." || name === "..") return undefined
  return { owner, name, full: `${owner}/${name}` }
}

/** The repository a `https://<host>/owner/name(.git)(/…)` URL names, with the path segments after it. */
function parseRepoUrl(value: string): { repo: RepoName; rest: string[] } | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || !isGitHubHost(url.hostname)) return undefined
  const [owner, name, ...rest] = url.pathname.split("/").filter(Boolean)
  const repo = owner && name ? repoName(owner, name.replace(GIT_SUFFIX, "")) : undefined
  return repo && { repo, rest }
}

/** Accepts `owner/name` and `https://github.com/owner/name(.git)(/…)`. */
export function parseRepo(value: string): RepoName {
  const text = value.trim()
  const pair = REPO_PATTERN.exec(text)
  const repo = pair ? repoName(pair[1]!, pair[2]!) : parseRepoUrl(text)?.repo
  if (!repo) throw invalid(`"${value}" is not a repository; use owner/name or its GitHub URL.`)
  return repo
}

/** The repository an `origin` remote URL (https, scp-like ssh or `ssh://`) points at on GitHub. */
function parseOriginUrl(origin: string): RepoName | undefined {
  let host: string
  let path: string
  const scp = SCP_PATTERN.exec(origin)
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return undefined
    }
    host = url.hostname
    path = url.pathname
  }
  const aliased = host.toLowerCase() === SSH_ALIAS_HOST && process.env.GH_HOST === undefined
  if (!isGitHubHost(aliased ? DEFAULT_HOST : host)) return undefined
  const segments = path.split("/").filter(Boolean)
  const [owner, name] = segments
  return segments.length === 2 && owner && name ? repoName(owner, name.replace(GIT_SUFFIX, "")) : undefined
}

/**
 * What a message may say about a remote URL that is not usable: never its
 * credentials or query. An https or ssh:// URL is echoed without userinfo, an
 * scp-like one by host only, and anything else not at all.
 */
function describeOrigin(origin: string): string {
  const scp = SCP_PATTERN.exec(origin)
  if (scp) return ` (host ${scp[1]})`
  try {
    const url = new URL(origin)
    url.username = ""
    url.password = ""
    return ` (${url.protocol}//${url.host}${url.pathname})`
  } catch {
    return ""
  }
}

/** Git sees the user's configuration, so `url.<base>.insteadOf` rules apply to the remote it reports. */
function gitEnv(): Record<string, string> {
  const env = passthroughEnv()
  for (const name of GIT_CONFIG_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0" }
}

/** Whether `dir` is `root` or inside it, compared by real path; a path that cannot be resolved is not. */
export async function isWithin(dir: string, root: string): Promise<boolean> {
  try {
    const path = relative(await realpath(root), await realpath(dir))
    return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  } catch {
    return false
  }
}

/**
 * The working tree's repository, read from its `origin` remote. A `cwd` that is
 * `ownDir` or inside it is never a working tree, so it fails without asking git.
 */
export async function repoFromOrigin(cwd: string, signal?: AbortSignal, ownDir?: string): Promise<RepoName> {
  const env = gitEnv()
  const unresolved = (why: string, advice = "") =>
    invalid(
      `Cannot tell which repository to use: ${why}. Run the call inside a clone of a GitHub repository, or pass \`repo\` as owner/name.${advice}`,
    )

  if (ownDir !== undefined && (await isWithin(cwd, ownDir))) {
    throw unresolved(
      `${cwd} is where these tools are installed, not a project`,
      " An issue can be given as `owner/repo#N`.",
    )
  }
  let result: ExecResult
  try {
    result = await exec(["git", "remote", "get-url", "origin"], { cwd, env, signal })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw unresolved("git is not installed")
    throw error
  }
  const origin = result.stdout.trim()
  if (result.code !== 0 || !origin) throw unresolved(`${cwd} has no \`origin\` remote`)
  const repo = parseOriginUrl(origin)
  if (!repo) throw unresolved(`the \`origin\` remote${describeOrigin(origin)} is not a GitHub repository`)
  return repo
}

/** An explicit `repo` wins; without one the working tree's `origin` decides. */
export async function resolveRepo(repo: string | undefined, ctx: RefContext): Promise<RepoName> {
  return repo === undefined || repo.trim() === "" ? repoFromOrigin(ctx.cwd, ctx.signal, ctx.ownDir) : parseRepo(repo)
}

/** Whether a reference is a number alone (`12` or `#12`), which names no repository of its own. */
export function isBareNumber(ref: string): boolean {
  return BARE_NUMBER_PATTERN.test(ref.trim())
}

function parseNumber(digits: string, ref: string): number {
  const number = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(number) || number < 1)
    throw invalid(`"${ref}" does not name an issue or pull request number.`)
  return number
}

/** What a number reference may name: an issue, a pull request or either. */
export type RefAccept = "issue" | "pull" | "any"

export type NumberRefOptions = {
  /** Which kind of object the caller means; defaults to `"any"`. Only a URL says which kind it names. */
  accept?: RefAccept
}

const URL_KINDS = { issues: "issue", pull: "pull" } as const
const KIND_NOUNS = { issue: "an issue", pull: "a pull request" } as const

/** The repository and number a fully qualified reference names, or `undefined` for a bare number. */
function parseQualifiedRef(
  text: string,
  ref: string,
  accept: RefAccept,
): { repo: RepoName; number: number } | undefined {
  const qualified = QUALIFIED_NUMBER_PATTERN.exec(text)
  if (qualified) {
    const repo = repoName(qualified[1]!, qualified[2]!)
    if (!repo) throw invalid(`"${ref}" does not name a valid repository.`)
    return { repo, number: parseNumber(qualified[3]!, ref) }
  }
  const url = parseRepoUrl(text)
  if (url) {
    const [segment, digits] = url.rest
    const kind = segment === "issues" || segment === "pull" ? URL_KINDS[segment] : undefined
    if (!kind || !digits || !/^\d+$/.test(digits)) {
      throw invalid(`"${ref}" is not an issue or pull request URL.`)
    }
    if (accept !== "any" && kind !== accept) {
      throw invalid(`"${ref}" is ${KIND_NOUNS[kind]}, not ${KIND_NOUNS[accept]}.`)
    }
    return { repo: url.repo, number: parseNumber(digits, ref) }
  }
  return undefined
}

/**
 * Accepts `12`, `#12`, `owner/repo#12` and `https://github.com/owner/repo/(issues|pull)/12`
 * (anything after the number in a URL is ignored). A reference that names its
 * own repository must agree with `repoArg` when both are given. With
 * `accept: "issue"` or `"pull"`, a URL of the other kind is refused; the other
 * forms do not say which kind they name, so they pass.
 */
export async function parseNumberRef(
  ref: string,
  repoArg: string | undefined,
  ctx: RefContext,
  options: NumberRefOptions = {},
): Promise<{ repo: RepoName; number: number }> {
  const text = ref.trim()
  const qualified = parseQualifiedRef(text, ref, options.accept ?? "any")
  if (qualified) {
    if (repoArg !== undefined && repoArg.trim() !== "") {
      const other = parseRepo(repoArg)
      if (other.full.toLowerCase() !== qualified.repo.full.toLowerCase()) {
        throw invalid(`"${ref}" is in ${qualified.repo.full}, but repo is ${other.full}; pass one repository.`)
      }
    }
    return qualified
  }
  const bare = BARE_NUMBER_PATTERN.exec(text)
  if (!bare) {
    throw invalid(`"${ref}" is not an issue or pull request reference; use 12, #12, owner/repo#12 or its URL.`)
  }
  return { repo: await resolveRepo(repoArg, ctx), number: parseNumber(bare[1]!, ref) }
}
