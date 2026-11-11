import { ToolError } from "../errors"
import { graphql, lit } from "../gh"
import type { RefContext } from "../refs"
import { listOf } from "./board-field-values"
import { FIELD_SELECTION, READ_FIELD_SELECTION, toField, type BoardField, type RawField } from "./board-fields"
import {
  OPTION_COLORS,
  appendOptions,
  parseOptions,
  replaceOptions,
  type OptionInput,
  type OptionSpec,
} from "./board-options"
import {
  findIssueField,
  readOrganizationIssueFields,
  type IssueFieldDefinition,
  type IssueFieldType,
} from "./issue-fields"
import { sameTitle, type BoardOwnerType } from "./projects"

/** Creating a field, adding a column that mirrors an organization's issue field, and adding to or replacing the options of a single-select field. */

export const FIELD_TYPES = ["text", "number", "date", "single_select"] as const

export type FieldType = (typeof FIELD_TYPES)[number]

/** The field a Status column is: it can be extended, never created. */
export const STATUS_FIELD = "Status"

/** A field a call wants on the board; `options` is for a single select only. */
export type FieldRequest = { name: string; type: FieldType; options: OptionSpec[] }

/** A column a call wants on the board that mirrors the organization's issue field of this name; `type`, when given, must be the issue field's. */
export type IssueFieldColumnRequest = { name: string; type?: IssueFieldType }

/** Whose issue fields a column mirrors: the owner of the board, or of the board about to be made. */
export type IssueFieldOwner = { owner: string; owner_type: BoardOwnerType }

/** What `ensureField` did: the field as it is now, and which options were added or changed. */
export type FieldOutcome = {
  field: BoardField
  created: boolean
  added_options: string[]
  updated_options: string[]
}

/** How an existing single select takes the wanted options: appended after its own, or replacing its list. */
export type OptionPolicy = "append" | "replace"

const FIELD_REPLY = `projectV2Field{${FIELD_SELECTION}}`
const createFieldMutation = (type: FieldType, options: string) =>
  `mutation($project:ID!,$name:String!){createProjectV2Field(input:{projectId:$project,dataType:${type.toUpperCase()},name:$name${options}}){${FIELD_REPLY}}}`
const updateOptionsMutation = (options: string) =>
  `mutation($field:ID!){updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:${options}}){${FIELD_REPLY}}}`

const createIssueFieldColumnMutation = `mutation($project:ID!,$field:ID!){createProjectV2IssueField(input:{projectId:$project,issueFieldId:$field}){projectV2Field{${READ_FIELD_SELECTION}}}}`

type FieldReply = { projectV2Field?: (RawField & { id: string }) | null } | null

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/**
 * The request for a field, checked before anything is written: it has a name,
 * its options parse, and only a single select has options.
 */
export function fieldRequest(name: string, type: FieldType, options: readonly string[] | undefined): FieldRequest {
  const trimmed = name.trim()
  if (!trimmed) throw invalid("name cannot be blank.")
  const parsed = parseOptions(options)
  if (type !== "single_select" && parsed.length > 0) {
    throw invalid(`options are for a single_select field, not ${type}.`)
  }
  return { name: trimmed, type, options: parsed }
}

/** The request for an issue field column, checked before anything is written: it has a name. */
export function issueFieldColumnRequest(name: string, type?: IssueFieldType): IssueFieldColumnRequest {
  const trimmed = name.trim()
  if (!trimmed) throw invalid("name cannot be blank.")
  return { name: trimmed, type }
}

/**
 * The issue fields the owner's organization defines, for `requireIssueField`: `null` for a user, whose
 * read is skipped, and for a GitHub without issue fields.
 */
export async function readOwnerIssueFields(
  owner: IssueFieldOwner,
  ctx: RefContext,
): Promise<IssueFieldDefinition[] | null> {
  return owner.owner_type === "organization" ? readOrganizationIssueFields(owner.owner, ctx) : null
}

/**
 * The organization's issue field the request names (without regard to case), checked against the
 * definitions `readOwnerIssueFields` gave: it is `invalid_argument` when the owner is a user, when
 * GitHub has no issue fields, when the organization has no field of that name, and when the
 * request's type is not the field's. Nothing is written, so a caller can run it before making a board.
 */
export function requireIssueField(
  owner: IssueFieldOwner,
  definitions: readonly IssueFieldDefinition[] | null,
  request: IssueFieldColumnRequest,
): IssueFieldDefinition {
  if (owner.owner_type !== "organization") {
    throw invalid(`Issue fields belong to an organization; ${owner.owner} is a user.`)
  }
  if (!definitions) throw invalid("This GitHub has no issue fields.")
  const definition = findIssueField(definitions, request.name)
  if (!definition) {
    const names = listOf(definitions.map((field) => field.name))
    throw invalid(`${owner.owner} has no issue field "${request.name}". Issue fields: ${names}.`)
  }
  if (request.type && request.type !== definition.type) {
    throw invalid(`"${definition.name}" is ${definition.type}, not ${request.type}.`)
  }
  return definition
}

/** The options as a GraphQL list literal; GitHub's colors are enum values, so an unknown one is refused rather than interpolated. */
function optionsLiteral(options: readonly OptionInput[]): string {
  const items = options.map((option) => {
    if (!OPTION_COLORS.some((color) => color === option.color)) {
      throw new ToolError(
        "upstream_error",
        `Option "${option.name}" has the color "${option.color}", which GitHub does not list.`,
      )
    }
    const id = option.id ? `id:${lit(option.id)},` : ""
    return `{${id}name:${lit(option.name)},color:${option.color},description:${lit(option.description)}}`
  })
  return `[${items.join(",")}]`
}

function fieldOf(reply: FieldReply, name: string): BoardField {
  const raw = reply?.projectV2Field
  if (!raw?.id) throw new ToolError("upstream_error", `GitHub did not return the field "${name}" it changed.`)
  return toField(raw)
}

async function createField(board: { id: string }, request: FieldRequest, ctx: RefContext): Promise<FieldOutcome> {
  if (sameTitle(request.name, STATUS_FIELD)) {
    throw invalid(`${STATUS_FIELD} cannot be created, only extended; this board has no such field.`)
  }
  if (request.type === "single_select" && request.options.length === 0) {
    throw invalid(`A new single_select field needs options; "${request.name}" is not on the board.`)
  }
  const options = request.type === "single_select" ? `,singleSelectOptions:${optionsLiteral(request.options)}` : ""
  const data = await graphql<{ createProjectV2Field?: FieldReply } | null>(
    createFieldMutation(request.type, options),
    { project: board.id, name: request.name },
    ctx,
  )
  const field = fieldOf(data?.createProjectV2Field ?? null, request.name)
  return { field, created: true, added_options: request.options.map((option) => option.name), updated_options: [] }
}

/**
 * Makes the field of the request exist on the board whose `fields` are given:
 * a missing one is created, one of another type is `invalid_argument`, and an
 * existing single select takes the wanted options by `policy` (existing
 * options keep their id either way). Every check runs before the first write.
 */
export async function ensureField(
  board: { id: string },
  fields: readonly BoardField[],
  request: FieldRequest,
  policy: OptionPolicy,
  ctx: RefContext,
): Promise<FieldOutcome> {
  const existing = fields.find((field) => sameTitle(field.name, request.name))
  if (!existing) return createField(board, request, ctx)
  if (existing.type !== request.type) {
    throw invalid(`Field "${existing.name}" is ${existing.type}, not ${request.type}; use another name or type.`)
  }
  const unchanged: FieldOutcome = { field: existing, created: false, added_options: [], updated_options: [] }
  if (request.type !== "single_select" || request.options.length === 0) return unchanged

  const merge = (policy === "replace" ? replaceOptions : appendOptions)(existing.options ?? [], request.options)
  if (!merge.changed) return unchanged
  if (existing.issue_field) {
    throw invalid(
      `"${existing.name}" mirrors the organization's issue field; its options are the organization's and cannot be changed on a board.`,
    )
  }
  const data = await graphql<{ updateProjectV2Field?: FieldReply } | null>(
    updateOptionsMutation(optionsLiteral(merge.options)),
    { field: existing.id },
    ctx,
  )
  const field = fieldOf(data?.updateProjectV2Field ?? null, existing.name)
  return { field, created: false, added_options: merge.added, updated_options: merge.updated }
}

/**
 * Makes the board have a column that mirrors the organization's issue field the request names, given
 * the owner's `definitions` from `readOwnerIssueFields`. The column is the issue field's own, with its
 * name, type and options, so none are passed: a board that has it is returned unchanged and nothing is
 * written. `requireIssueField`'s refusals, and a field of the board's own with that name (GitHub would
 * fail on the repeated name), are `invalid_argument` before the first write.
 */
export async function ensureIssueFieldColumn(
  board: IssueFieldOwner & { id: string },
  fields: readonly BoardField[],
  definitions: readonly IssueFieldDefinition[] | null,
  request: IssueFieldColumnRequest,
  ctx: RefContext,
): Promise<FieldOutcome> {
  const definition = requireIssueField(board, definitions, request)
  const existing = fields.find((field) => sameTitle(field.name, definition.name))
  if (existing?.issue_field) return { field: existing, created: false, added_options: [], updated_options: [] }
  if (existing) {
    throw invalid(
      `The board has its own field "${existing.name}"; an issue field column cannot take the same name. Rename or delete the board's field in the web UI, or use the board's field.`,
    )
  }
  const data = await graphql<{ createProjectV2IssueField?: FieldReply } | null>(
    createIssueFieldColumnMutation,
    { project: board.id, field: definition.id },
    ctx,
  )
  const field = fieldOf(data?.createProjectV2IssueField ?? null, definition.name)
  return { field, created: true, added_options: [], updated_options: [] }
}
