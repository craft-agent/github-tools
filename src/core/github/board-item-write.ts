import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { graphql } from "../gh"
import type { RefContext, RepoName } from "../refs"
import type { FieldWrite } from "./board-field-values"
import type { BoardField } from "./board-fields"
import { PAGE_SIZE } from "./projects"

/** Board item reads and writes: finding the item an issue or pull request is on a board, adding items, setting and clearing field values, editing a draft, archiving, converting a draft. */

const CONTENT_FIELDS = `id number url repository{nameWithOwner} projectItems(first:${PAGE_SIZE},includeArchived:true){nodes{id isArchived project{id}}}`
const CONTENT_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$n){__typename ... on Issue{${CONTENT_FIELDS}} ... on PullRequest{${CONTENT_FIELDS}}}}}`

const ADD_CONTENT =
  "mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}"
const ADD_DRAFT =
  "mutation($project:ID!,$title:String!,$body:String){addProjectV2DraftIssue(input:{projectId:$project,title:$title,body:$body}){projectItem{id}}}"
const UPDATE_DRAFT =
  "mutation($draft:ID!,$title:String,$body:String){updateProjectV2DraftIssue(input:{draftIssueId:$draft,title:$title,body:$body}){draftIssue{id}}}"
const CLEAR_VALUE =
  "mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}"
const CONVERT_DRAFT =
  "mutation($item:ID!,$repo:ID!){convertProjectV2DraftIssueItemToIssue(input:{itemId:$item,repositoryId:$repo}){item{id content{... on Issue{number url}}}}}"
const setValueMutation = (declaration: string, value: string) =>
  `mutation($project:ID!,$item:ID!,$field:ID!${declaration}){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{${value}}}){projectV2Item{id}}}`
const archiveMutation = (name: string) =>
  `mutation($project:ID!,$item:ID!){${name}(input:{projectId:$project,itemId:$item}){item{id}}}`

/** How each kind of value but a number travels: as a GraphQL variable of this type, under this key of the value input. */
const VALUE_INPUTS = {
  text: { type: "String!", key: "text" },
  date: { type: "Date!", key: "date" },
  single_select: { type: "String!", key: "singleSelectOptionId" },
  iteration: { type: "String!", key: "iterationId" },
} as const satisfies Record<Exclude<FieldWrite["kind"], "number">, { type: string; key: string }>

/** An issue or pull request as a board item's result reports it. */
export const itemContentRefSchema = z.object({
  type: z.enum(["issue", "pr"]),
  repo: z.string().describe("owner/name of the repository that holds it."),
  number: z.number().int(),
  url: z.string(),
})

export type ItemContentRef = z.output<typeof itemContentRefSchema>

/** An issue or pull request with its node ID and the board items it has, archived ones included. */
export type BoardContent = ItemContentRef & {
  id: string
  items: { id: string; archived: boolean; board_id: string }[]
}

type RawContent = {
  __typename?: string
  id?: string
  number?: number
  url?: string
  repository?: { nameWithOwner?: string } | null
  projectItems?: {
    nodes?: ({ id: string; isArchived?: boolean; project?: { id?: string } | null } | null)[] | null
  } | null
}

function requireId(id: string | null | undefined, what: string): string {
  if (!id) {
    throw new ToolError(
      "upstream_error",
      `GitHub did not return the ${what} it made; look at the board before running this again.`,
    )
  }
  return id
}

/**
 * The issue or pull request `ref` names, with the board items it has (the
 * first 100, archived included). One that does not exist, or cannot be seen,
 * is `not_found`.
 */
export async function readBoardContent(
  ref: { repo: RepoName; number: number },
  ctx: RefContext,
): Promise<BoardContent> {
  const notFound = (cause?: unknown) =>
    new ToolError(
      "not_found",
      `Issue or pull request ${ref.repo.full}#${ref.number} was not found, or the viewer cannot see it.`,
      { cause },
    )
  let data: { repository?: { issueOrPullRequest?: RawContent | null } | null } | null
  try {
    data = await graphql(CONTENT_QUERY, { owner: ref.repo.owner, name: ref.repo.name, n: ref.number }, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw notFound(error)
    throw error
  }
  const raw = data?.repository?.issueOrPullRequest
  if (!raw?.id || (raw.__typename !== "Issue" && raw.__typename !== "PullRequest")) throw notFound()
  const items = (raw.projectItems?.nodes ?? []).flatMap((node) =>
    node?.project?.id ? [{ id: node.id, archived: Boolean(node.isArchived), board_id: node.project.id }] : [],
  )
  return {
    id: raw.id,
    type: raw.__typename === "Issue" ? "issue" : "pr",
    repo: raw.repository?.nameWithOwner ?? ref.repo.full,
    number: raw.number ?? ref.number,
    url: raw.url ?? "",
    items,
  }
}

/** Puts an issue or pull request, by its node ID, on the board; returns the new item's ID. */
export async function addContentToBoard(projectId: string, contentId: string, ctx: RefContext): Promise<string> {
  const data = await graphql<{ addProjectV2ItemById?: { item?: { id?: string } | null } | null } | null>(
    ADD_CONTENT,
    { project: projectId, content: contentId },
    ctx,
  )
  return requireId(data?.addProjectV2ItemById?.item?.id, "board item")
}

/** Adds a draft to the board; returns the new item's ID. */
export async function addDraftToBoard(
  projectId: string,
  draft: { title: string; body?: string },
  ctx: RefContext,
): Promise<string> {
  const data = await graphql<{ addProjectV2DraftIssue?: { projectItem?: { id?: string } | null } | null } | null>(
    ADD_DRAFT,
    { project: projectId, title: draft.title, body: draft.body },
    ctx,
  )
  return requireId(data?.addProjectV2DraftIssue?.projectItem?.id, "draft")
}

/** Changes a draft's title, body or both, by the node ID of its text (`DI_…`); what is left out stays as it is. */
export async function updateDraft(
  draftId: string,
  text: { title?: string; body?: string },
  ctx: RefContext,
): Promise<void> {
  await graphql(UPDATE_DRAFT, { draft: draftId, title: text.title, body: text.body }, ctx)
}

/** Sets one field of an item to a checked value. */
export async function setFieldValue(
  projectId: string,
  itemId: string,
  write: FieldWrite,
  ctx: RefContext,
): Promise<void> {
  const ids = { project: projectId, item: itemId, field: write.field.id }
  if (write.kind === "number") {
    await graphql(setValueMutation("", `number:${write.sent}`), ids, ctx)
    return
  }
  const { type, key } = VALUE_INPUTS[write.kind]
  await graphql(setValueMutation(`,$value:${type}`, `${key}:$value`), { ...ids, value: String(write.sent) }, ctx)
}

/** Empties one field of an item. */
export async function clearFieldValue(
  projectId: string,
  itemId: string,
  field: Pick<BoardField, "id">,
  ctx: RefContext,
): Promise<void> {
  await graphql(CLEAR_VALUE, { project: projectId, item: itemId, field: field.id }, ctx)
}

/** Archives an item, or brings an archived one back. */
export async function setItemArchived(
  projectId: string,
  itemId: string,
  archived: boolean,
  ctx: RefContext,
): Promise<void> {
  await graphql(
    archiveMutation(archived ? "archiveProjectV2Item" : "unarchiveProjectV2Item"),
    {
      project: projectId,
      item: itemId,
    },
    ctx,
  )
}

/** Turns a draft item into an issue of the repository with this node ID; returns the issue. */
export async function convertDraftToIssue(
  itemId: string,
  repositoryId: string,
  ctx: RefContext,
): Promise<{ number: number; url: string }> {
  const data = await graphql<{
    convertProjectV2DraftIssueItemToIssue?: {
      item?: { content?: { number?: number; url?: string } | null } | null
    } | null
  } | null>(CONVERT_DRAFT, { item: itemId, repo: repositoryId }, ctx)
  const issue = data?.convertProjectV2DraftIssueItemToIssue?.item?.content
  if (!issue?.number || !issue.url) {
    throw new ToolError(
      "upstream_error",
      "GitHub did not return the issue the draft became; it may have been converted, so look at the board before running this again.",
    )
  }
  return { number: issue.number, url: issue.url }
}
