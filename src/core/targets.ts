import { isAbortError } from "./errors"
import {
  CURRENT_USER,
  boardOwnerLogin,
  boardResource,
  givenOwner,
  isBoardItemId,
  newBoardResource,
  parseBoardProject,
  readBoardItemBoard,
  resolveBoard,
  viewerLogin,
  type BoardSelector,
} from "./github/projects"
import { isBareNumber, parseNumberRef, parseRepo, resolveRepo, type RefContext, type RepoName } from "./refs"
import type { TargetKind, ToolSpec } from "./tool"

/** What stands for a repository or board that cannot be told. */
export const ANY_TARGET = "*"

type Args = Readonly<Record<string, unknown>>
type OwnRepository = () => Promise<RepoName | undefined>

/** The name of the argument that holds the issue a call is about. */
const ISSUE_ARGUMENT = "issue"
/** The name of the argument that holds the repository a call is about. */
const REPO_ARGUMENT = "repo"

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

/** Keeps the answer of `resolve`, which runs on the first call only. */
function once(resolve: OwnRepository): OwnRepository {
  let pending: Promise<RepoName | undefined> | undefined
  return () => (pending ??= resolve())
}

/** The repository the `repo` argument names, else the working tree's `origin`, read on the first call that needs it. */
function argumentRepository(args: Args, ctx: RefContext): OwnRepository {
  const repo = args[REPO_ARGUMENT]
  return once(async () => {
    if (repo !== undefined && typeof repo !== "string") return undefined
    return attempt(() => resolveRepo(repo, ctx))
  })
}

/**
 * The call's own repository: that of the `issue` argument when it names one,
 * else `repo`, else the working tree's `origin`. The origin is read on the
 * first call that needs it, and the answer is kept.
 */
function ownRepository(
  spec: Pick<ToolSpec, "targets">,
  args: Args,
  fromArguments: OwnRepository,
  ctx: RefContext,
): OwnRepository {
  const issue = args[ISSUE_ARGUMENT]

  return once(async () => {
    if (spec.targets?.[ISSUE_ARGUMENT] === "issue" && typeof issue === "string" && !isBareNumber(issue)) {
      const named = await attempt(() => parseNumberRef(issue, undefined, ctx, { accept: "issue" }))
      if (named) return named.repo
    }
    return fromArguments()
  })
}

function isBoardKind(kind: TargetKind): boolean {
  return kind === "board" || kind === "item" || kind === "owner"
}

/** An argument's text; `undefined` when it is absent, `null` when it is not text. */
function textOf(value: unknown): string | undefined | null {
  return value === undefined || typeof value === "string" ? value : null
}

/** The arguments that choose a board, or `undefined` when one is not text. `project` is the value of the declared argument. */
function boardSelector(args: Args, project: unknown): BoardSelector | undefined {
  const values = [project, args.owner, args[REPO_ARGUMENT]].map(textOf)
  if (values.includes(null)) return undefined
  const [projectText, owner, repo] = values as (string | undefined)[]
  return { project: projectText, owner, repo }
}

/**
 * The board the selectors choose, as `owner/projects/N`. A `project` that is
 * `owner/N` or a URL needs no `gh`; a bare number takes `owner`, else the
 * owner of the repository, and only `@me` asks for the viewer's login. A
 * `project` that is a title, or none, runs the lookup of `resolveBoard`, which
 * reads and never writes. A blank `project` cannot be told.
 */
async function boardTarget(
  selector: BoardSelector | undefined,
  repository: OwnRepository,
  ctx: RefContext,
): Promise<string | undefined> {
  if (!selector) return undefined
  return attempt(async () => {
    const project = selector.project === undefined ? undefined : parseBoardProject(selector.project)
    if (!project || "title" in project) return boardResource((await resolveBoard(selector, ctx)).project)
    const { ref } = project
    const login = await boardOwnerLogin(ref, selector.owner, async () => {
      const repo = await repository()
      if (!repo) throw new Error("no repository")
      return repo.owner
    })
    return boardResource({ owner: login === CURRENT_USER ? await viewerLogin(ctx) : login, number: ref.number })
  })
}

/** The board of a project item: read from GitHub when the value is a node ID, else chosen by the selectors. */
async function itemTarget(
  value: unknown,
  selector: BoardSelector | undefined,
  repository: OwnRepository,
  ctx: RefContext,
): Promise<string | undefined> {
  if (typeof value !== "string") return undefined
  if (!isBoardItemId(value)) return boardTarget(selector, repository, ctx)
  return attempt(async () => boardResource(await readBoardItemBoard(value.trim(), ctx)))
}

/** The board about to be created for an owner, as `owner/projects/new`; `@me` asks for the viewer's login. */
async function ownerTarget(value: unknown, ctx: RefContext): Promise<string | undefined> {
  if (typeof value !== "string") return undefined
  return attempt(async () => {
    const login = givenOwner(value)
    if (login === undefined) return undefined
    return newBoardResource(login === CURRENT_USER ? await viewerLogin(ctx) : login)
  })
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
 * What a call writes to, as the permission rule of an entry point names it:
 * the call's own repository (`owner/name`), and each repository the arguments
 * declared in `spec.targets` name. A bare issue number means the call's own
 * repository. Anything that cannot be told (an invalid or non-string value, a
 * working tree without a GitHub `origin`) is `*`. A spec without `targets` has
 * just its own repository.
 *
 * A spec with a `"board"`, `"item"` or `"owner"` target names no own repository:
 * it writes to a board (`owner/projects/N`), and to a repository only through a
 * `repo` argument declared as a `"repo"` target (the working tree's when `repo`
 * is absent). An `"owner"` target names the board to be created for that owner,
 * `owner/projects/new` (`*` when the owner is absent or invalid; `@me` reads the
 * viewer's login). The board is told without `gh` where the arguments say it
 * (`owner/N`, a URL, a number with `owner`, `repo` or the working tree); a
 * board they name by title, or not at all, is found with the lookup of `resolveBoard`,
 * and an item's board is read from GitHub, which only read. For repositories
 * nothing here calls `gh`, and the `origin` is read only when a bare number or
 * a missing `repo` needs it.
 *
 * Lowercase, without repeats, sorted, with `*` last.
 */
export async function writeTargets(spec: Pick<ToolSpec, "targets">, args: unknown, ctx: RefContext): Promise<string[]> {
  const given: Args = typeof args === "object" && args !== null ? (args as Args) : {}
  const targets = Object.entries(spec.targets ?? {})
  const namesBoard = targets.some(([, kind]) => isBoardKind(kind))
  const fromArguments = argumentRepository(given, ctx)
  const own = ownRepository(spec, given, fromArguments, ctx)
  const found = new Set<string>()
  const addResource = (resource: string | undefined) => found.add(resource ?? ANY_TARGET)
  const add = (repo: RepoName | undefined) => addResource(repo?.full.toLowerCase())

  if (!namesBoard) add(await own())
  for (const [name, kind] of targets) {
    const value = given[name]
    if (kind === "board") {
      addResource(await boardTarget(boardSelector(given, value), fromArguments, ctx))
      continue
    }
    if (kind === "owner") {
      addResource(await ownerTarget(value, ctx))
      continue
    }
    if (value === undefined || (namesBoard && name === REPO_ARGUMENT && kind === "repo")) continue
    if (kind === "item") {
      if (!isBlank(value)) addResource(await itemTarget(value, boardSelector(given, given.project), fromArguments, ctx))
      continue
    }
    if (kind === "issues" && !Array.isArray(value)) {
      add(undefined)
      continue
    }
    for (const item of kind === "issues" ? (value as unknown[]) : [value]) {
      if (!isBlank(item)) add(await targetRepository(kind, item, own, ctx))
    }
  }
  if (namesBoard && spec.targets?.[REPO_ARGUMENT] === "repo") add(await fromArguments())
  if (found.size === 0) addResource(undefined)

  const resources = [...found].filter((resource) => resource !== ANY_TARGET).sort()
  return found.has(ANY_TARGET) ? [...resources, ANY_TARGET] : resources
}
