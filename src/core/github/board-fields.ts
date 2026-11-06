import { z } from "zod"
import { paginate } from "../gh"
import type { RefContext } from "../refs"
import { isIssueFieldsMissingError } from "./issue-fields"
import { PAGE_INFO, PAGE_SIZE } from "./projects"

/** Project board reads of a board's structure: its fields, with their options and iterations, and its views. */

const VIEW_LAYOUT_SUFFIX = /_LAYOUT$/

/** What a read or a write of a field selects of it, whatever its kind. */
export const FIELD_SELECTION =
  "__typename ... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name color description}} ... on ProjectV2IterationField{configuration{iterations{id title startDate duration}}}"

const ISSUE_FIELD_SELECTION =
  "isIssueField issueField{__typename ... on IssueFieldSingleSelect{options{id name color description}}}"

export const READ_FIELD_SELECTION = `${FIELD_SELECTION} ... on ProjectV2Field{${ISSUE_FIELD_SELECTION}} ... on ProjectV2SingleSelectField{${ISSUE_FIELD_SELECTION}}`

const FIELDS_QUERY = `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{fields(first:${PAGE_SIZE},after:$after){${PAGE_INFO} nodes{${READ_FIELD_SELECTION}}}}}}`
const FALLBACK_FIELDS_QUERY = `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{fields(first:${PAGE_SIZE},after:$after){${PAGE_INFO} nodes{${FIELD_SELECTION}}}}}}`
const VIEWS_QUERY = `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{views(first:${PAGE_SIZE},after:$after){${PAGE_INFO} nodes{id number name layout filter}}}}}`

export const boardFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z
    .string()
    .describe("GitHub's data type in lower case: text, number, date, single_select, iteration, title, assignees, …"),
  issue_field: z
    .boolean()
    .describe(
      "Whether the column mirrors one of the organization's issue fields: its value is the issue's own, set with the issue tools, not on the board.",
    ),
  options: z
    .array(z.object({ id: z.string(), name: z.string(), color: z.string(), description: z.string() }))
    .optional()
    .describe("single_select: the options, in order."),
  iterations: z
    .array(z.object({ id: z.string(), title: z.string(), start_date: z.string(), duration: z.number().int() }))
    .optional()
    .describe("iteration: the iterations; duration is in days."),
})

export const boardViewSchema = z.object({
  number: z.number().int(),
  name: z.string(),
  layout: z.string().describe("table, board or roadmap."),
  filter: z.string().nullable(),
})

export type BoardField = z.output<typeof boardFieldSchema>
export type BoardView = z.output<typeof boardViewSchema>

export type RawField = {
  id?: string
  name?: string
  dataType?: string
  isIssueField?: boolean | null
  issueField?: {
    __typename?: string
    options?: { id: string; name: string; color?: string; description?: string | null }[] | null
  } | null
  options?: { id: string; name: string; color?: string; description?: string | null }[] | null
  configuration?: {
    iterations?: { id: string; title: string; startDate: string; duration: number }[] | null
  } | null
}

type RawView = { id: string; number: number; name: string; layout?: string; filter?: string | null }

/** A view with the node ID that deleting it takes. */
export type BoardViewNode = BoardView & { id: string }

/** The field as a tool reports it, from the reply of a read or a write. */
export function toField(raw: RawField & { id: string }): BoardField {
  const isIssueField = Boolean(raw.isIssueField)
  const field: BoardField = {
    id: raw.id,
    name: raw.name ?? "",
    type: (raw.dataType ?? "").toLowerCase(),
    issue_field: isIssueField,
  }
  const rawOptions = isIssueField
    ? (raw.issueField?.options ?? (field.type === "single_select" ? [] : undefined))
    : raw.options
  if (rawOptions) {
    field.options = rawOptions.map((option) => ({
      id: option.id,
      name: option.name,
      color: option.color ?? "",
      description: option.description ?? "",
    }))
  }
  if (raw.configuration?.iterations) {
    field.iterations = raw.configuration.iterations.map((iteration) => ({
      id: iteration.id,
      title: iteration.title,
      start_date: iteration.startDate,
      duration: iteration.duration,
    }))
  }
  return field
}

/** Every field of a board by its node ID, in GitHub's order, with the options of a single select and the iterations of an iteration field. */
export async function readBoardFields(projectId: string, ctx: RefContext): Promise<BoardField[]> {
  const fetchFields = async (query: string) => {
    const { items } = await paginate<RawField | null>(query, { id: projectId }, (data) => data?.node?.fields, {
      cwd: ctx.cwd,
      signal: ctx.signal,
    })
    return items.filter((raw): raw is RawField & { id: string } => Boolean(raw?.id)).map(toField)
  }

  try {
    return await fetchFields(FIELDS_QUERY)
  } catch (error) {
    if (isIssueFieldsMissingError(error)) {
      return await fetchFields(FALLBACK_FIELDS_QUERY)
    }
    throw error
  }
}

/** Every view of a board by its node ID, in GitHub's order, each with its own node ID. */
export async function readBoardViewNodes(projectId: string, ctx: RefContext): Promise<BoardViewNode[]> {
  const { items } = await paginate<RawView | null>(VIEWS_QUERY, { id: projectId }, (data) => data?.node?.views, {
    cwd: ctx.cwd,
    signal: ctx.signal,
  })
  return items
    .filter((raw): raw is RawView => raw != null)
    .map((raw) => ({
      id: raw.id,
      number: raw.number,
      name: raw.name,
      layout: (raw.layout ?? "").replace(VIEW_LAYOUT_SUFFIX, "").toLowerCase(),
      filter: raw.filter ?? null,
    }))
}

/** Every view of a board by its node ID, in GitHub's order. */
export async function readBoardViews(projectId: string, ctx: RefContext): Promise<BoardView[]> {
  const nodes = await readBoardViewNodes(projectId, ctx)
  return nodes.map(({ number, name, layout, filter }) => ({ number, name, layout, filter }))
}
