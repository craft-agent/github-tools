import { ToolError } from "./errors"

export type RepoName = { owner: string; name: string; full: string }

const DEFAULT_HOST = "github.com"
/** Enterprise Managed User logins contain `_`. */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const REPO_PATTERN = /^([^/\s#]+)\/([^/\s#]+)$/
const GIT_SUFFIX = /\.git$/

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function isGitHubHost(host: string): boolean {
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
