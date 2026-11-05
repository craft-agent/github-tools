import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { graphql, paginate, type Page } from "../gh"
import { OWNER_PATTERN, isGitHubHost, resolveRepo, type RefContext, type RepoName } from "../refs"

/** Project board reads shared by the board tools: the lookup of a board, and the boards of an owner or repository. */

/** The title of the board that is looked up when the call names none. */
export const DEFAULT_BOARD_TITLE = "Roadmap"
/** Stands for the viewer where a login is expected. */
export const CURRENT_USER = "@me"

/** The size of one page of a GraphQL connection read, and the selection that tells whether another follows. */
export const PAGE_SIZE = 100
export const PAGE_INFO = "pageInfo{hasNextPage endCursor}"
/** The most boards read from one owner or repository; a lookup that stops there says so. */
const BOARD_SCAN_LIMIT = 1000
const DIGITS = /^\d+$/
const OWNER_NUMBER_PATTERN = /^([^/\s]+)\/(\d+)$/
const URL_OWNER_SEGMENTS = ["orgs", "users"]

const BOARD_ROUTES = ["named", "owner", "linked", "organization", "viewer"] as const
const OWNER_TYPES = ["organization", "user"] as const

/** What a read or a write of a board selects of it. */
export const PROJECT_FIELDS =
  "id number title url closed viewerCanUpdate owner{__typename ... on User{login} ... on Organization{login}}"
const BOARDS = `projectsV2(first:${PAGE_SIZE},after:$after){${PAGE_INFO} nodes{${PROJECT_FIELDS}}}`

const ITEM_ID_PATTERN = /^PVTI_[A-Za-z0-9_-]+$/

const OWNER_TYPE_QUERY = "query($login:String!){repositoryOwner(login:$login){__typename}}"
const VIEWER_QUERY = "query{viewer{login}}"
const VIEWER_BOARDS_QUERY = `query($after:String){viewer{${BOARDS}}}`
const LINKED_BOARDS_QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){owner{__typename login} ${BOARDS}}}`
const ITEM_BOARD_QUERY = `query($id:ID!){node(id:$id){... on ProjectV2Item{project{${PROJECT_FIELDS}}}}}`

export const boardSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  owner: z.string().describe("The login of the user or organization that owns the board."),
  owner_type: z.enum(OWNER_TYPES),
  closed: z.boolean(),
  can_update: z.boolean().describe("Whether the viewer may change the board."),
})

export const consideredSchema = z.object({
  route: z.enum(BOARD_ROUTES),
  outcome: z.string().describe("The board the route found, or why it found none."),
})

export type Board = z.output<typeof boardSchema>
export type BoardOwnerType = Board["owner_type"]
export type BoardRoute = (typeof BOARD_ROUTES)[number]
export type Considered = z.output<typeof consideredSchema>

/** The board a lookup found, the route that found it and what every route tried said. */
export type ResolvedBoard = { project: Board; route: BoardRoute; considered: Considered[] }

/** The arguments that choose a board, as a tool takes them. */
export type BoardSelector = { project?: string; owner?: string; repo?: string }

/** A board reference: its number, and its owner's login when the reference names one. */
export type BoardRef = { number: number; owner?: string }

/** A page of boards, with whether the scan stopped before the last one. */
export type Boards = { boards: Board[]; truncated: boolean }

type RawOwner = { __typename?: string; login?: string } | null | undefined

export type RawBoard = {
  id: string
  number: number
  title: string
  url: string
  closed?: boolean
  viewerCanUpdate?: boolean
  owner?: RawOwner
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** An argument's text with its surrounding space removed; blank counts as not given. */
export function given(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** Whether two names (of boards, fields, options or views) are the same without regard to case or surrounding space. */
export function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function ownerType(typename: string | undefined): BoardOwnerType {
  return typename === "Organization" ? "organization" : "user"
}

/** The board as a tool reports it, from the reply of a read or a write. */
export function toBoard(raw: RawBoard): Board {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    owner: raw.owner?.login ?? "",
    owner_type: ownerType(raw.owner?.__typename),
    closed: Boolean(raw.closed),
    can_update: Boolean(raw.viewerCanUpdate),
  }
}

/** The board as a permission rule names it: `owner/projects/N`, the owner in lower case. */
export function boardResource(board: Pick<Board, "owner" | "number">): string {
  return `${board.owner.toLowerCase()}/projects/${board.number}`
}

/** What a permission rule names a board about to be made for `owner`: `owner/projects/new`. */
export function newBoardResource(owner: string): string {
  return `${owner.toLowerCase()}/projects/new`
}

function describeBoard(board: Board): string {
  return `${boardResource(board)} "${board.title}"`
}

/** Throws `forbidden` unless the viewer may change the board, so a write fails before it changes anything. */
export function assertBoardWritable(board: Board): void {
  if (board.can_update) return
  throw new ToolError(
    "forbidden",
    `The viewer cannot update ${boardResource(board)}. Use a board the viewer can edit, or ask its owner for access.`,
  )
}

function boardNumber(digits: string, ref: string): number {
  const number = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(`"${ref}" does not name a board number.`)
  return number
}

/** The reference a `https://<host>/(orgs|users)/<owner>/projects/N(/views/N)(?…)` URL holds. */
function parseBoardUrl(text: string, ref: string): BoardRef | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || !isGitHubHost(url.hostname)) return undefined
  const [kind, owner, projects, digits, ...rest] = url.pathname.split("/").filter(Boolean)
  const isView = rest.length === 2 && rest[0] === "views" && DIGITS.test(rest[1]!)
  if (!kind || !URL_OWNER_SEGMENTS.includes(kind) || !owner || !OWNER_PATTERN.test(owner)) return undefined
  if (projects !== "projects" || !digits || !DIGITS.test(digits) || (rest.length > 0 && !isView)) return undefined
  return { owner, number: boardNumber(digits, ref) }
}

/** The reference `text` is, or `undefined` when it is none; a number that cannot be a board's is `invalid_argument`. */
function matchBoardRef(text: string, value: string): BoardRef | undefined {
  if (DIGITS.test(text)) return { number: boardNumber(text, value) }
  const pair = OWNER_NUMBER_PATTERN.exec(text)
  if (pair && OWNER_PATTERN.test(pair[1]!)) return { owner: pair[1]!, number: boardNumber(pair[2]!, value) }
  return parseBoardUrl(text, value)
}

/**
 * Accepts a board's number (`3`), `owner/3` and its URL
 * (`https://github.com/orgs/<owner>/projects/3` or `…/users/<owner>/projects/3`,
 * with a trailing `/views/N` or a query). Anything else is `invalid_argument`.
 */
export function parseBoardRef(value: string): BoardRef {
  const ref = matchBoardRef(value.trim(), value)
  if (!ref) throw invalid(`"${value}" is not a board; use its number, owner/number or its GitHub URL.`)
  return ref
}

/** What a `project` argument holds: a reference to one board, or the title of the board to look up. */
export type BoardProject = { ref: BoardRef } | { title: string }

/**
 * Tells a `project` argument that is a board reference (see `parseBoardRef`)
 * from one that is a board's title, which is trimmed. A blank value is
 * `invalid_argument`: leave `project` out to look up the default board.
 */
export function parseBoardProject(value: string): BoardProject {
  const text = value.trim()
  if (!text) {
    throw invalid(
      `project is empty; give a board's number, owner/number, URL or title, or leave it out for the default.`,
    )
  }
  const ref = matchBoardRef(text, value)
  return ref ? { ref } : { title: text }
}

/** Whether a value looks like the node ID of a project item (`PVTI_…`). */
export function isBoardItemId(value: string): boolean {
  return ITEM_ID_PATTERN.test(value.trim())
}

/** The login of an `owner` argument (a login or `@me`), or `undefined` when none was given; anything else is `invalid_argument`. */
export function givenOwner(value: string | undefined): string | undefined {
  const owner = given(value)
  if (owner !== undefined && owner !== CURRENT_USER && !OWNER_PATTERN.test(owner)) {
    throw invalid(`"${owner}" is not a user or organization login; use a login or ${CURRENT_USER}.`)
  }
  return owner
}

/**
 * The login (or `@me`) whose board `ref` names, without asking GitHub: the
 * reference's own owner, else the `owner` argument, else what `fallback` reads
 * (the owner of the repository the call is about).
 */
export async function boardOwnerLogin(
  ref: BoardRef,
  owner: string | undefined,
  fallback: () => Promise<string>,
): Promise<string> {
  return ref.owner ?? givenOwner(owner) ?? fallback()
}

/** Runs a read, turning GitHub's "could not resolve" into the `not_found` of the thing it asked for. */
async function orNotFound<T>(read: () => Promise<T>, notFound: (cause: unknown) => ToolError): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw notFound(error)
    throw error
  }
}

const ownerNotFound = (login: string) => (cause?: unknown) =>
  new ToolError("not_found", `No user or organization named ${login} was found, or the viewer cannot see it.`, {
    cause,
  })

const boardNotFound = (login: string, number: number) => (cause?: unknown) =>
  new ToolError("not_found", `Board ${login}/projects/${number} was not found, or the viewer cannot see it.`, { cause })

const repositoryNotFound = (repo: RepoName) => (cause?: unknown) =>
  new ToolError("not_found", `Repository ${repo.full} was not found, or the viewer cannot see it.`, { cause })

/** The login of the person `gh` is authenticated as. */
export async function viewerLogin(ctx: RefContext): Promise<string> {
  const data = await graphql<{ viewer?: { login?: string } | null } | null>(VIEWER_QUERY, {}, ctx)
  const login = data?.viewer?.login
  if (!login) throw new ToolError("github_error", "GitHub did not say who the viewer is.")
  return login
}

/** What GitHub names an owner's boards under: `organization` or `user`. */
async function ownerRoot(login: string, ctx: RefContext): Promise<BoardOwnerType> {
  const data = await orNotFound(
    () => graphql<{ repositoryOwner?: { __typename?: string } | null } | null>(OWNER_TYPE_QUERY, { login }, ctx),
    ownerNotFound(login),
  )
  const typename = data?.repositoryOwner?.__typename
  if (typename !== "Organization" && typename !== "User") throw ownerNotFound(login)()
  return ownerType(typename)
}

/** One board by its owner's login and number; `root` skips the lookup of the owner's type when the caller knows it. */
async function boardByNumber(login: string, number: number, ctx: RefContext, root?: BoardOwnerType): Promise<Board> {
  const kind = root ?? (await ownerRoot(login, ctx))
  const query = `query($login:String!,$n:Int!){${kind}(login:$login){projectV2(number:$n){${PROJECT_FIELDS}}}}`
  const data = await orNotFound(
    () =>
      graphql<Partial<Record<BoardOwnerType, { projectV2?: RawBoard | null } | null>> | null>(
        query,
        { login, n: number },
        ctx,
      ),
    boardNotFound(login, number),
  )
  const raw = data?.[kind]?.projectV2
  if (!raw) throw boardNotFound(login, number)()
  return toBoard(raw)
}

async function scanBoards(
  query: string,
  vars: Record<string, string>,
  pick: (data: any) => Page<RawBoard | null> | null | undefined,
  ctx: RefContext,
): Promise<Boards> {
  const { items, truncated } = await paginate(query, vars, pick, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    limit: BOARD_SCAN_LIMIT,
  })
  return { boards: items.filter((raw): raw is RawBoard => raw != null).map(toBoard), truncated }
}

/** The boards of the viewer. */
async function viewerBoards(ctx: RefContext): Promise<Boards> {
  return scanBoards(VIEWER_BOARDS_QUERY, {}, (data) => data?.viewer?.projectsV2, ctx)
}

/**
 * The boards of a user or organization, or the viewer's for `@me`, closed ones
 * included; `root` skips the lookup of the owner's type when the caller knows
 * it. A login that is neither is `not_found`.
 */
export async function ownerBoards(login: string, ctx: RefContext, root?: BoardOwnerType): Promise<Boards> {
  if (login === CURRENT_USER) return viewerBoards(ctx)
  const kind = root ?? (await ownerRoot(login, ctx))
  const query = `query($login:String!,$after:String){${kind}(login:$login){${BOARDS}}}`
  return scanBoards(query, { login }, (data) => data?.[kind]?.projectsV2, ctx)
}

/**
 * The boards linked to a repository, closed ones included, with the
 * repository's owner. A repository that does not exist or cannot be seen is
 * `not_found`.
 */
export async function linkedBoards(
  repo: RepoName,
  ctx: RefContext,
): Promise<Boards & { owner: { login: string; type: BoardOwnerType } }> {
  const seen: { owner?: RawOwner } = {}
  const scanned = await orNotFound(
    () =>
      scanBoards(
        LINKED_BOARDS_QUERY,
        { owner: repo.owner, name: repo.name },
        (data) => {
          seen.owner = data?.repository?.owner
          return data?.repository?.projectsV2
        },
        ctx,
      ),
    repositoryNotFound(repo),
  )
  if (!seen.owner) throw repositoryNotFound(repo)()
  return { ...scanned, owner: { login: seen.owner.login ?? repo.owner, type: ownerType(seen.owner.__typename) } }
}

/**
 * The one open board of `wanted` title among `boards`, noted in `considered`.
 * Several are `invalid_argument` naming them: nothing is picked by guess.
 */
function boardTitled(route: BoardRoute, boards: Boards, wanted: string, considered: Considered[]): Board | undefined {
  const matches = boards.boards.filter((board) => !board.closed && sameTitle(board.title, wanted))
  if (matches.length > 1) {
    throw invalid(
      `${matches.length} open boards titled "${wanted}" on the ${route} route: ${matches.map(describeBoard).join(", ")}. Name one with \`project\` as owner/number or its URL.`,
    )
  }
  const [board] = matches
  const searched = boards.truncated ? ` (only the first ${BOARD_SCAN_LIMIT} boards were searched)` : ""
  considered.push({ route, outcome: board ? describeBoard(board) : `no open board titled "${wanted}"${searched}` })
  return board
}

function notFoundByTitle(wanted: string, considered: Considered[]): ToolError {
  const tried = considered.map(({ route, outcome }) => `${route}: ${outcome}`).join("; ")
  return new ToolError("not_found", `No open board titled "${wanted}" was found. Routes tried: ${tried}.`)
}

/** The board a `project` reference names, used as it is, closed or not. */
async function namedBoard(
  ref: BoardRef,
  owner: string | undefined,
  repo: string | undefined,
  ctx: RefContext,
): Promise<ResolvedBoard> {
  const login = await boardOwnerLogin(ref, owner, async () => (await resolveRepo(repo, ctx)).owner)
  const isViewer = login === CURRENT_USER
  const board = await boardByNumber(
    isViewer ? await viewerLogin(ctx) : login,
    ref.number,
    ctx,
    isViewer ? "user" : undefined,
  )
  return { project: board, route: "named", considered: [{ route: "named", outcome: describeBoard(board) }] }
}

/**
 * The open board of the wanted title: an `owner` names where to look, else the
 * boards linked to the repository, the organization that owns it and the
 * viewer, in that order. A repository that cannot be read fails the lookup.
 */
async function findBoard(
  wanted: string,
  owner: string | undefined,
  repoArg: string | undefined,
  ctx: RefContext,
): Promise<ResolvedBoard> {
  const considered: Considered[] = []
  const found = (route: BoardRoute, board: Board): ResolvedBoard => ({ project: board, route, considered })

  if (owner !== undefined) {
    const board = boardTitled("owner", await ownerBoards(owner, ctx), wanted, considered)
    if (board) return found("owner", board)
    throw notFoundByTitle(wanted, considered)
  }

  const repo = await resolveRepo(repoArg, ctx)
  const linked = await linkedBoards(repo, ctx)
  const linkedBoard = boardTitled("linked", linked, wanted, considered)
  if (linkedBoard) return found("linked", linkedBoard)

  if (linked.owner.type === "organization") {
    const organization = await ownerBoards(linked.owner.login, ctx, "organization")
    const board = boardTitled("organization", organization, wanted, considered)
    if (board) return found("organization", board)
  } else {
    considered.push({ route: "organization", outcome: `${repo.full} is owned by a user, not an organization` })
  }

  const viewerBoard = boardTitled("viewer", await viewerBoards(ctx), wanted, considered)
  if (viewerBoard) return found("viewer", viewerBoard)
  throw notFoundByTitle(wanted, considered)
}

/**
 * The board a call means. A `project` that is a reference (a number,
 * `owner/number` or a URL) is used as it is, closed or not; a number takes its
 * owner from `owner`, else from `repo` or the working tree's repository. Any
 * other `project` is a title, and an absent one is `Roadmap`: the open board of
 * that whole title (trimmed, case-insensitive) is looked up in `owner`'s boards,
 * or in those linked to `repo` (default: the working tree's repository), then
 * its organization's, then the viewer's. `considered` says what each route
 * found. Several boards of the title on one route are `invalid_argument`
 * listing them, none anywhere is `not_found` naming the routes tried; a
 * repository that cannot be read fails the call. A blank `project` is
 * `invalid_argument`. Reads only.
 */
export async function resolveBoard(selector: BoardSelector, ctx: RefContext): Promise<ResolvedBoard> {
  const owner = givenOwner(selector.owner)
  const repo = given(selector.repo)
  if (selector.project === undefined) return findBoard(DEFAULT_BOARD_TITLE, owner, repo, ctx)
  const project = parseBoardProject(selector.project)
  return "ref" in project ? namedBoard(project.ref, owner, repo, ctx) : findBoard(project.title, owner, repo, ctx)
}

/** The board a project item (`PVTI_…`) sits on; an item that does not exist or cannot be seen is `not_found`. */
export async function readBoardItemBoard(itemId: string, ctx: RefContext): Promise<Board> {
  const notFound = () =>
    new ToolError("not_found", `Project item ${itemId} was not found, or the viewer cannot see it.`)
  const data = await orNotFound(
    () => graphql<{ node?: { project?: RawBoard | null } | null } | null>(ITEM_BOARD_QUERY, { id: itemId }, ctx),
    notFound,
  )
  const project = data?.node?.project
  if (!project) throw notFound()
  return toBoard(project)
}
