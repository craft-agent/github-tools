import { ToolError } from "../errors"
import { graphql, lit } from "../gh"
import type { RefContext } from "../refs"
import { FIELD_SELECTION, toField, type BoardField, type RawField } from "./board-fields"
import {
  OPTION_COLORS,
  appendOptions,
  parseOptions,
  replaceOptions,
  type OptionInput,
  type OptionSpec,
} from "./board-options"
import { sameTitle } from "./projects"

/** Creating a field, and adding to or replacing the options of a single-select field. */

export const FIELD_TYPES = ["text", "number", "date", "single_select"] as const

export type FieldType = (typeof FIELD_TYPES)[number]

/** The field a Status column is: it can be extended, never created. */
export const STATUS_FIELD = "Status"

/** A field a call wants on the board; `options` is for a single select only. */
export type FieldRequest = { name: string; type: FieldType; options: OptionSpec[] }

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

/** The options as a GraphQL list literal; GitHub's colors are enum values, so an unknown one is refused rather than interpolated. */
function optionsLiteral(options: readonly OptionInput[]): string {
  const items = options.map((option) => {
    if (!OPTION_COLORS.some((color) => color === option.color)) {
      throw new ToolError(
        "github_error",
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
  if (!raw?.id) throw new ToolError("github_error", `GitHub did not return the field "${name}" it changed.`)
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
