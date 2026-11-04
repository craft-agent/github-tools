import { isAbortError } from "./errors"
import { isBareNumber, parseNumberRef, parseRepo, resolveRepo, type RefContext, type RepoName } from "./refs"
import type { TargetKind, ToolSpec } from "./tool"

/** What stands for a repository that cannot be told. */
export const ANY_TARGET = "*"

type Args = Readonly<Record<string, unknown>>
type OwnRepository = () => Promise<RepoName | undefined>

/** The name of the argument that holds the issue a call is about. */
const ISSUE_ARGUMENT = "issue"

/** The result of `fn`, or `undefined` when it fails; a cancellation is never swallowed. */
async function attempt<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error) {
    if (isAbortError(error)) throw error
    return undefined
  }
}

function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === ""
}

/**
 * The call's own repository: that of the `issue` argument when it names one,
 * else `repo`, else the working tree's `origin`. The origin is read on the
 * first call that needs it, and the answer is kept.
 */
function ownRepository(spec: Pick<ToolSpec, "targets">, args: Args, ctx: RefContext): OwnRepository {
  const repo = args.repo
  const issue = args[ISSUE_ARGUMENT]
  let pending: Promise<RepoName | undefined> | undefined

  async function resolve(): Promise<RepoName | undefined> {
    if (spec.targets?.[ISSUE_ARGUMENT] === "issue" && typeof issue === "string" && !isBareNumber(issue)) {
      const named = await attempt(() => parseNumberRef(issue, undefined, ctx, { accept: "issue" }))
      if (named) return named.repo
    }
    if (repo !== undefined && typeof repo !== "string") return undefined
    return attempt(() => resolveRepo(repo, ctx))
  }

  return () => (pending ??= resolve())
}

/** The repository an issue reference names: its own when qualified, the call's when it is a bare number. */
async function issueRepository(value: unknown, own: OwnRepository, ctx: RefContext): Promise<RepoName | undefined> {
  if (typeof value !== "string") return undefined
  const bare = isBareNumber(value)
  const repoArg = bare ? (await own())?.full : undefined
  if (bare && repoArg === undefined) return undefined
  return attempt(async () => (await parseNumberRef(value, repoArg, ctx, { accept: "issue" })).repo)
}

/** The repository one value of a declared argument names, or `undefined` when it cannot be told. */
async function targetRepository(
  kind: TargetKind,
  value: unknown,
  own: OwnRepository,
  ctx: RefContext,
): Promise<RepoName | undefined> {
  if (kind !== "repo") return issueRepository(value, own, ctx)
  return typeof value === "string" ? attempt(() => parseRepo(value)) : undefined
}

/**
 * The repositories a call writes to, as the permission rule of an entry point
 * names them: the call's own repository, and each repository the arguments
 * declared in `spec.targets` name. A bare issue number means the call's own
 * repository. Anything that cannot be told (an invalid or non-string value, a
 * working tree without a GitHub `origin`) is `*`. Nothing here calls `gh`, and
 * the `origin` is read only when a bare number or a missing `repo` needs it.
 * A spec without `targets` has just its own repository.
 *
 * Lowercase, without repeats, sorted, with `*` last.
 */
export async function writeTargets(spec: Pick<ToolSpec, "targets">, args: unknown, ctx: RefContext): Promise<string[]> {
  const given: Args = typeof args === "object" && args !== null ? (args as Args) : {}
  const own = ownRepository(spec, given, ctx)
  const found = new Set<string>()
  const add = (repo: RepoName | undefined) => found.add(repo ? repo.full.toLowerCase() : ANY_TARGET)

  add(await own())
  for (const [name, kind] of Object.entries(spec.targets ?? {})) {
    const value = given[name]
    if (value === undefined) continue
    if (kind === "issues" && !Array.isArray(value)) {
      add(undefined)
      continue
    }
    for (const item of kind === "issues" ? (value as unknown[]) : [value]) {
      if (!isBlank(item)) add(await targetRepository(kind, item, own, ctx))
    }
  }

  const repos = [...found].filter((repo) => repo !== ANY_TARGET).sort()
  return found.has(ANY_TARGET) ? [...repos, ANY_TARGET] : repos
}
