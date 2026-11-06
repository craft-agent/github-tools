import { z } from "zod"
import { graphql, paginate } from "../gh"
import type { RefContext } from "../refs"
import {
  isIssueFieldsMissingError,
  issueFieldValueOf,
  ISSUE_FIELD_VALUE_SELECTION,
  type RawIssueFieldValue,
} from "./issue-fields"
import { stateWord } from "./issues"
import { readKind } from "./kind"

/** Board item reads: a board's items in one flat shape, whatever their content is, with field values flattened by field name. */

const PAGE_SIZE = 100
/** The most items read from one board; a board with more is reported as truncated. */
export const MAX_BOARD_ITEMS = 2000
const FIELD_VALUES = 50
const CONTENT_LABELS = 20
const CONTENT_ASSIGNEES = 10
const FIELD_LABELS = 20
const FIELD_USERS = 10
const FIELD_PULL_REQUESTS = 10

const FIELD_NAME = "field{... on ProjectV2FieldCommon{name}}"

function itemFields(includeIssueFields = true): string {
  const issueFieldSelection = includeIssueFields
    ? `\n ... on ProjectV2ItemIssueFieldValue{${FIELD_NAME} issueFieldValue{${ISSUE_FIELD_VALUE_SELECTION}}}`
    : ""
  return `id isArchived
fieldValues(first:${FIELD_VALUES}){nodes{
 ... on ProjectV2ItemFieldTextValue{text ${FIELD_NAME}}
 ... on ProjectV2ItemFieldNumberValue{number ${FIELD_NAME}}
 ... on ProjectV2ItemFieldDateValue{date ${FIELD_NAME}}
 ... on ProjectV2ItemFieldSingleSelectValue{name ${FIELD_NAME}}
 ... on ProjectV2ItemFieldIterationValue{title startDate duration ${FIELD_NAME}}
 ... on ProjectV2ItemFieldMilestoneValue{milestone{title} ${FIELD_NAME}}
 ... on ProjectV2ItemFieldRepositoryValue{repository{nameWithOwner} ${FIELD_NAME}}
 ... on ProjectV2ItemFieldLabelValue{labels(first:${FIELD_LABELS}){nodes{name}} ${FIELD_NAME}}
 ... on ProjectV2ItemFieldUserValue{users(first:${FIELD_USERS}){nodes{login}} ${FIELD_NAME}}
 ... on ProjectV2ItemFieldPullRequestValue{pullRequests(first:${FIELD_PULL_REQUESTS}){nodes{number}} ${FIELD_NAME}}${issueFieldSelection}
}}
content{__typename
 ... on DraftIssue{id title body}
 ... on Issue{number title url issueState: state repository{nameWithOwner} issueType{name} labels(first:${CONTENT_LABELS}){nodes{name}} assignees(first:${CONTENT_ASSIGNEES}){nodes{login}} parent{number repository{nameWithOwner}} subIssuesSummary{total completed}}
 ... on PullRequest{number title url pullRequestState: state repository{nameWithOwner} labels(first:${CONTENT_LABELS}){nodes{name}} assignees(first:${CONTENT_ASSIGNEES}){nodes{login}}}
}`
}

const ITEM_FIELDS = itemFields(true)
const ITEM_FIELDS_WITHOUT_ISSUE_FIELDS = itemFields(false)

const itemsQuery = (fields: string) =>
  `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{items(first:${PAGE_SIZE},after:$after){pageInfo{hasNextPage endCursor} nodes{${fields}}}}}}`
const itemQuery = (fields: string) => `query($id:ID!){node(id:$id){... on ProjectV2Item{${fields}}}}`

const ITEMS_QUERY = itemsQuery(ITEM_FIELDS)
const ITEMS_QUERY_WITHOUT_ISSUE_FIELDS = itemsQuery(ITEM_FIELDS_WITHOUT_ISSUE_FIELDS)
const ITEM_QUERY = itemQuery(ITEM_FIELDS)
const ITEM_QUERY_WITHOUT_ISSUE_FIELDS = itemQuery(ITEM_FIELDS_WITHOUT_ISSUE_FIELDS)

export const iterationValueSchema = z.object({
  title: z.string(),
  start_date: z.string(),
  duration: z.number().int().describe("In days."),
})

export const itemFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
  iterationValueSchema,
])

export const itemContentSchema = z.object({
  type: z.enum(["draft", "issue", "pr"]),
  title: z.string(),
  body: z.string().optional().describe("draft: the text."),
  number: z.number().int().optional(),
  url: z.string().optional(),
  repo: z.string().optional().describe("owner/name of the repository that holds the issue or pull request."),
  state: z.string().optional().describe("open or closed; a pull request may also be merged."),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  kind: z.string().nullable().optional().describe("issue: its Issue Type, else the type:<kind> label; null for none."),
  parent: z.string().nullable().optional().describe("issue: its parent as owner/repo#N, else null."),
  sub_issues: z
    .object({ total: z.number().int(), completed: z.number().int() })
    .optional()
    .describe("issue: progress."),
})

export const boardItemSchema = z.object({
  item_id: z.string(),
  archived: z.boolean(),
  fields: z
    .record(z.string(), itemFieldValueSchema)
    .describe(
      "Values by field name: text, number, date and single select as they are (the option's name), a column mirroring an organization issue field as the issue's value (an option's name, or a list of names for a multi-select), iteration as { title, start_date, duration }, milestone as its title, repository as owner/name, labels as names, users as logins, linked pull requests as numbers.",
    ),
  content: itemContentSchema.nullable().describe("What the item stands for; null when GitHub did not return it."),
})

export type ItemFieldValue = z.output<typeof itemFieldValueSchema>
export type ItemContent = z.output<typeof itemContentSchema>
export type BoardItem = z.output<typeof boardItemSchema>

type Nodes<T> = { nodes?: (T | null)[] | null } | null | undefined

type RawFieldValue = {
  field?: { name?: string } | null
  issueFieldValue?: RawIssueFieldValue | null
  text?: string | null
  number?: number | null
  date?: string | null
  name?: string | null
  title?: string
  startDate?: string
  duration?: number
  milestone?: { title: string } | null
  repository?: { nameWithOwner?: string } | null
  labels?: Nodes<{ name: string }>
  users?: Nodes<{ login: string }>
  pullRequests?: Nodes<{ number: number }>
}

type RawContent = {
  __typename?: string
  id?: string
  title?: string | null
  body?: string | null
  number?: number
  url?: string
  issueState?: string
  pullRequestState?: string
  repository?: { nameWithOwner?: string } | null
  issueType?: { name?: string } | null
  labels?: Nodes<{ name: string }>
  assignees?: Nodes<{ login: string }>
  parent?: { number: number; repository?: { nameWithOwner?: string } | null } | null
  subIssuesSummary?: { total: number; completed: number } | null
}

type RawItem = {
  id: string
  isArchived?: boolean
  fieldValues?: Nodes<RawFieldValue>
  content?: RawContent | null
}

function nodesOf<T>(connection: Nodes<T>): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node != null)
}

/** One field value as the tools report it; `undefined` for a kind of value that is not reported. */
function fieldValue(raw: RawFieldValue): ItemFieldValue | undefined {
  if ("issueFieldValue" in raw) return issueFieldValueOf(raw.issueFieldValue)
  if ("text" in raw) return raw.text ?? null
  if ("number" in raw) return raw.number ?? null
  if ("date" in raw) return raw.date ?? null
  if ("startDate" in raw)
    return { title: raw.title ?? "", start_date: raw.startDate ?? "", duration: raw.duration ?? 0 }
  if ("name" in raw) return raw.name ?? null
  if ("milestone" in raw) return raw.milestone?.title ?? null
  if ("repository" in raw) return raw.repository?.nameWithOwner ?? null
  if ("labels" in raw) return nodesOf(raw.labels).map((label) => label.name)
  if ("users" in raw) return nodesOf(raw.users).map((user) => user.login)
  if ("pullRequests" in raw) return nodesOf(raw.pullRequests).map((pull) => pull.number)
  return undefined
}

function toContent(raw: RawContent | null | undefined): ItemContent | null {
  const labels = nodesOf(raw?.labels).map((label) => label.name)
  const assignees = nodesOf(raw?.assignees).map((assignee) => assignee.login)
  const repo = raw?.repository?.nameWithOwner ?? ""
  switch (raw?.__typename) {
    case "DraftIssue":
      return { type: "draft", title: raw.title ?? "", body: raw.body ?? "" }
    case "Issue":
      return {
        type: "issue",
        number: raw.number ?? 0,
        title: raw.title ?? "",
        url: raw.url ?? "",
        repo,
        state: stateWord(raw.issueState ?? ""),
        assignees,
        labels,
        kind: readKind(raw.issueType?.name, labels),
        parent: raw.parent ? `${raw.parent.repository?.nameWithOwner ?? ""}#${raw.parent.number}` : null,
        sub_issues: { total: raw.subIssuesSummary?.total ?? 0, completed: raw.subIssuesSummary?.completed ?? 0 },
      }
    case "PullRequest":
      return {
        type: "pr",
        number: raw.number ?? 0,
        title: raw.title ?? "",
        url: raw.url ?? "",
        repo,
        state: stateWord(raw.pullRequestState ?? ""),
        assignees,
        labels,
      }
    default:
      return null
  }
}

function toItem(raw: RawItem): BoardItem {
  const values = nodesOf(raw.fieldValues).flatMap((value) => {
    const name = value.field?.name
    const flat = name ? fieldValue(value) : undefined
    return name && flat !== undefined ? [[name, flat] as const] : []
  })
  return {
    item_id: raw.id,
    archived: Boolean(raw.isArchived),
    fields: Object.fromEntries(values),
    content: toContent(raw.content),
  }
}

/**
 * The items of a board by its node ID, archived ones included, in GitHub's
 * order, in pages of 100 up to `MAX_BOARD_ITEMS`; `truncated` says the board
 * holds more.
 */
export async function readBoardItems(
  projectId: string,
  ctx: RefContext,
): Promise<{ items: BoardItem[]; truncated: boolean }> {
  const run = (query: string) =>
    paginate<RawItem | null>(query, { id: projectId }, (data) => data?.node?.items, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      limit: MAX_BOARD_ITEMS,
    })
  let result: Awaited<ReturnType<typeof run>>
  try {
    result = await run(ITEMS_QUERY)
  } catch (error) {
    if (isIssueFieldsMissingError(error)) {
      result = await run(ITEMS_QUERY_WITHOUT_ISSUE_FIELDS)
    } else {
      throw error
    }
  }
  return { items: result.items.filter((raw): raw is RawItem => raw != null).map(toItem), truncated: result.truncated }
}

/** One item read on its own; `draftId` is the node ID of a draft's text (`DI_…`), which editing the draft takes. */
export type BoardItemRead = { item: BoardItem; draftId: string | null }

/** One item by its node ID, in the shape `readBoardItems` gives; `null` when it does not exist or cannot be seen. */
export async function readBoardItem(itemId: string, ctx: RefContext): Promise<BoardItemRead | null> {
  let data: { node?: RawItem | null } | null
  try {
    data = await graphql<{ node?: RawItem | null } | null>(ITEM_QUERY, { id: itemId }, ctx)
  } catch (error) {
    if (isIssueFieldsMissingError(error)) {
      data = await graphql<{ node?: RawItem | null } | null>(ITEM_QUERY_WITHOUT_ISSUE_FIELDS, { id: itemId }, ctx)
    } else {
      throw error
    }
  }
  const raw = data?.node
  if (!raw?.id) return null
  return { item: toItem(raw), draftId: raw.content?.__typename === "DraftIssue" ? (raw.content.id ?? null) : null }
}
