import { ToolError, isAbortError, isToolError } from "../errors"
import { gh, ghJson, graphql, lit } from "../gh"
import type { RefContext } from "../refs"
import { readBoardFields, type BoardField, type BoardView } from "./board-fields"
import { given, sameTitle, type Board } from "./projects"

/**
 * Creating a saved view through the REST API, which is the only one that sets
 * its fields, sorting and grouping, then ordering its columns through GraphQL,
 * which REST ignores; and deleting one.
 */

export const VIEW_LAYOUTS = ["table", "board", "roadmap"] as const

export type ViewLayout = (typeof VIEW_LAYOUTS)[number]

/** A view a call wants on the board; every field is named, not numbered. */
export type ViewRequest = {
  name: string
  layout: ViewLayout
  filter?: string
  /** The fields shown, in order; not for a roadmap. */
  fields?: readonly string[]
  group_by?: string
  /** The field a board layout's columns follow. */
  column_by?: string
  sort_by?: string
  sort_desc?: boolean
}

/** The view a call made or found. */
export type ViewRef = Pick<BoardView, "number" | "name" | "layout">

/** The board fields as REST numbers them, which is what a view's body takes. */
type RestField = { id: number; name: string }

type RestView = { number?: number; node_id?: string } | null

type ViewBody = {
  name: string
  layout: ViewLayout
  filter?: string
  visible_fields?: number[]
  sort_by?: [number, "asc" | "desc"][]
  group_by?: number[]
  vertical_group_by?: number[]
}

/** Reads a board's fields; see `viewFieldReaders`. */
export type ViewFieldReaders = {
  rest: () => Promise<RestField[]>
  graphql: () => Promise<BoardField[]>
}

/** The view exists, but its columns could not be put in the requested order; they show in the board's field order. */
export class ViewColumnsError extends ToolError {
  readonly view: ViewRef

  constructor(view: ViewRef, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      "upstream_error",
      `The view "${view.name}" (number ${view.number}) was created, but its columns are in the board's field order, not the requested one: ${reason}`,
      { cause },
    )
    this.name = "ViewColumnsError"
    this.view = view
  }
}

const REST_API_VERSION_HEADER = "X-GitHub-Api-Version: 2026-03-10"
const FIELDS_PAGE = "per_page=100"
/** Fields GitHub does not let a view group or split by. */
const UNGROUPABLE_FIELDS = ["Sub-issues progress", "Linked pull requests"]
const DELETE_VIEW = "mutation($view:ID!){deleteProjectV2View(input:{viewId:$view}){clientMutationId}}"
const UPDATE_COLUMNS = (ids: readonly string[]) =>
  `mutation($view:ID!){updateProjectV2View(input:{viewId:$view,configuration:{visibleFieldIds:[${ids.map(lit).join(",")}]}}){projectV2View{id}}}`

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The names of a list argument, trimmed and without blanks or repeats. */
function nameList(names: readonly string[] | undefined): string[] {
  const kept: string[] = []
  for (const name of names ?? []) {
    const trimmed = name.trim()
    if (trimmed && !kept.some((other) => sameTitle(other, trimmed))) kept.push(trimmed)
  }
  return kept
}

function checkGrouping(argument: string, field: string | undefined): void {
  const refused = UNGROUPABLE_FIELDS.find((name) => field !== undefined && sameTitle(name, field))
  if (refused) throw invalid(`${argument}: GitHub cannot group or split a view by ${refused}.`)
}

/**
 * The request with its text trimmed, once its arguments are checked against
 * each other (before anything is read): a name, no `fields` on a roadmap,
 * `column_by` on a board layout only, no field GitHub cannot group by, and
 * `sort_desc` only with `sort_by`.
 */
export function checkViewRequest(request: ViewRequest): ViewRequest {
  const name = request.name.trim()
  if (!name) throw invalid("name cannot be blank.")
  const fields = nameList(request.fields)
  const group_by = given(request.group_by)
  const column_by = given(request.column_by)
  const sort_by = given(request.sort_by)
  if (request.layout === "roadmap" && fields.length > 0) {
    throw invalid("fields do not apply to a roadmap view; leave them out.")
  }
  if (column_by !== undefined && request.layout !== "board") throw invalid("column_by is for the board layout only.")
  checkGrouping("group_by", group_by)
  checkGrouping("column_by", column_by)
  if (request.sort_desc && sort_by === undefined) throw invalid("sort_desc needs sort_by.")
  return {
    name,
    layout: request.layout,
    filter: given(request.filter),
    fields,
    group_by,
    column_by,
    sort_by,
    sort_desc: request.sort_desc,
  }
}

function ownerRoot(board: Pick<Board, "owner_type">): string {
  return board.owner_type === "organization" ? "orgs" : "users"
}

async function readRestFields(
  board: Pick<Board, "owner" | "owner_type" | "number">,
  ctx: RefContext,
): Promise<RestField[]> {
  const path = `${ownerRoot(board)}/${board.owner}/projectsV2/${board.number}/fields?${FIELDS_PAGE}`
  // --slurp keeps the pages a valid JSON document: an array of one array per page.
  const pages =
    (await ghJson<RestField[][]>(["api", "-H", REST_API_VERSION_HEADER, path, "--paginate", "--slurp"], ctx)) ?? []
  return pages.flat().filter((field) => typeof field?.id === "number" && typeof field.name === "string")
}

/**
 * Readers of the board's fields, each reading once, when the first view needs
 * it: with the numbers REST gives them, and with the node IDs GraphQL gives
 * them. Made per call, so the fields are those of the moment the first view
 * is made.
 */
export function viewFieldReaders(
  board: Pick<Board, "id" | "owner" | "owner_type" | "number">,
  ctx: RefContext,
): ViewFieldReaders {
  let rest: Promise<RestField[]> | undefined
  let graphqlFields: Promise<BoardField[]> | undefined
  return {
    rest: () => (rest ??= readRestFields(board, ctx)),
    graphql: () => (graphqlFields ??= readBoardFields(board.id, ctx)),
  }
}

function viewBody(request: ViewRequest, fields: readonly RestField[]): ViewBody {
  const findField = (name: string) => fields.find((field) => sameTitle(field.name, name))
  const wanted = nameList(
    [...(request.fields ?? []), request.group_by, request.column_by, request.sort_by].filter(
      (name) => name !== undefined,
    ),
  )
  const unknown = wanted.filter((name) => !findField(name))
  if (unknown.length > 0) {
    throw invalid(
      `The board has no field ${unknown.map((name) => `"${name}"`).join(", ")}; its fields are ${fields.map((field) => field.name).join(", ")}.`,
    )
  }
  const idOf = (name: string) => findField(name)!.id

  const body: ViewBody = { name: request.name, layout: request.layout }
  if (request.filter) body.filter = request.filter
  if (request.fields?.length) body.visible_fields = request.fields.map(idOf)
  if (request.sort_by) body.sort_by = [[idOf(request.sort_by), request.sort_desc ? "desc" : "asc"]]
  if (request.group_by) body.group_by = [idOf(request.group_by)]
  if (request.column_by) body.vertical_group_by = [idOf(request.column_by)]
  return body
}

/**
 * A user's numeric id, which `gh api users/<login>` tells. The REST reference
 * names a user board's view route by this id, but GitHub answers that route by
 * the login, so the id is only the fallback.
 */
async function userId(login: string, ctx: RefContext): Promise<string> {
  const id = (await gh(["api", `users/${login}`, "--jq", ".id"], ctx)).trim()
  if (!/^\d+$/.test(id))
    throw new ToolError("upstream_error", `GitHub did not give the numeric id of the user ${login}.`)
  return id
}

function viewsPath(board: Pick<Board, "owner" | "owner_type" | "number">, owner: string): string {
  return `${ownerRoot(board)}/${owner}/projectsV2/${board.number}/views`
}

/** The node IDs of the fields a view shows, in the requested order. */
function columnIds(names: readonly string[], fields: readonly BoardField[]): string[] {
  return names.map((name) => {
    const field = fields.find((candidate) => sameTitle(candidate.name, name))
    if (!field)
      throw invalid(`The board has no field "${name}"; its fields are ${fields.map((f) => f.name).join(", ")}.`)
    return field.id
  })
}

/**
 * Puts the view's columns in the requested order, which REST ignores (it keeps
 * the board's field order). A failure is a `ViewColumnsError`, which says that
 * the view exists.
 */
async function orderColumns(view: ViewRef, nodeId: unknown, ids: readonly string[], ctx: RefContext): Promise<void> {
  try {
    if (typeof nodeId !== "string") throw new Error("GitHub did not return the view's node id.")
    await graphql(UPDATE_COLUMNS(ids), { view: nodeId }, ctx)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ViewColumnsError(view, error)
  }
}

/**
 * Creates the view on the board, then, when it shows fields, puts them in the
 * requested order with one GraphQL update. The request is checked against the
 * board's fields before the one REST write; a field the board lacks is
 * `invalid_argument` listing the board's fields. A failed reorder throws a
 * `ViewColumnsError` after the view exists.
 */
export async function createView(
  board: Pick<Board, "owner" | "owner_type" | "number">,
  request: ViewRequest,
  readers: ViewFieldReaders,
  ctx: RefContext,
): Promise<ViewRef> {
  const body = viewBody(request, await readers.rest())
  const columns = request.fields?.length ? columnIds(request.fields, await readers.graphql()) : undefined
  const post = (path: string) =>
    ghJson<RestView>(["api", "--method", "POST", "-H", REST_API_VERSION_HEADER, path, "--input", "-"], {
      ...ctx,
      stdin: JSON.stringify(body),
    })
  let made: RestView
  try {
    made = await post(viewsPath(board, board.owner))
  } catch (error) {
    // A 404 created nothing, so the route by the user's id is safe to try.
    if (board.owner_type !== "user" || !isToolError(error) || error.code !== "not_found") throw error
    made = await post(viewsPath(board, await userId(board.owner, ctx)))
  }
  if (typeof made?.number !== "number") {
    throw new ToolError(
      "upstream_error",
      `GitHub did not return the view "${request.name}" it created; look at the board before trying again.`,
    )
  }
  const view = { number: made.number, name: request.name, layout: request.layout }
  if (columns) await orderColumns(view, made.node_id, columns, ctx)
  return view
}

/** Deletes a view by its node ID. */
export async function deleteView(viewId: string, ctx: RefContext): Promise<void> {
  await graphql(DELETE_VIEW, { view: viewId }, ctx)
}
