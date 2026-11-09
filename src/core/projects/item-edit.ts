import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "../errors"
import { isEmptyValue, isHeld, planClears, planFieldValues, type FieldValue } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { clearFieldValue, setFieldValue, updateDraft } from "../github/board-item-write"
import { assertBoardWritable, given, sameTitle } from "../github/projects"
import { appended, invalid } from "../write-support"
import { defineTool } from "../tool"
import { resolveBoardItem } from "./item-resolve"
import {
  FIELDS_NOTE,
  ITEM_BOARD_SELECTION,
  ITEM_NOTE,
  contentNoun,
  fieldValuesArgument,
  itemArgument,
} from "./item-support"
import { BOARD_LOOKUP_NOTE, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  item: itemArgument,
  ...ITEM_BOARD_SELECTION,
  fields: fieldValuesArgument,
  clear_fields: z
    .array(z.string())
    .optional()
    .describe(
      "Names of the fields to empty. A column that mirrors an issue field is cleared with clear_issue_fields in github_issue_edit, not here.",
    ),
  title: z.string().optional().describe("Drafts only: the new title."),
  body: z.string().optional().describe("Drafts only: the new body, which replaces the whole old one; empty clears it."),
  append_body: z
    .string()
    .optional()
    .describe("Drafts only: text added after the current body, set off by a blank line."),
})

const output = z.object({
  project: boardSummarySchema,
  item_id: z.string(),
  changed: z
    .array(z.string())
    .describe(
      "What was written: field names as the board spells them, then title and body; [] when everything was already in place.",
    ),
})

type Args = z.output<typeof input>

/** The arguments of one edit, checked and cleaned up. */
type Change = {
  values: Readonly<Record<string, FieldValue>>
  clears: string[]
  title?: string
  body?: string
  appendBody?: string
}

/** Refuses what cannot describe one edit, before any call to GitHub. */
function parseChange(args: Args): Change {
  const values = args.fields ?? {}
  const clears = args.clear_fields ?? []
  const both = clears.find((name) => Object.keys(values).some((key) => sameTitle(key, name)))
  if (both !== undefined) throw invalid(`Field "${both}" is in both fields and clear_fields; pass one of them.`)
  const appendBody = given(args.append_body) === undefined ? undefined : args.append_body
  if (args.body !== undefined && appendBody !== undefined) {
    throw invalid("body replaces the whole body and append_body adds to it; pass one of them.")
  }
  const title = given(args.title)
  if (args.title !== undefined && !title) throw invalid("title is blank; pass the new title, or leave it out.")
  const change: Change = { values, clears, title, body: args.body, appendBody }
  if (Object.keys(values).length === 0 && clears.length === 0 && !hasDraftText(change)) {
    throw invalid("Nothing to change: pass at least one of fields, clear_fields, title, body or append_body.")
  }
  return change
}

function hasDraftText(change: Change): boolean {
  return change.title !== undefined || change.body !== undefined || change.appendBody !== undefined
}

/** The failure of a write, saying what the call had already written, since the rest of the edit did not happen. */
function withWritten(error: unknown, written: readonly string[]): unknown {
  if (written.length === 0 || isAbortError(error) || !isToolError(error)) return error
  return new ToolError(error.code, `${error.message} Written before it failed: ${written.join(", ")}.`, {
    cause: error,
  })
}

export const projectItemEdit = defineTool({
  id: "github_project_item_edit",
  title: "Edit a GitHub project item",
  intent: "About to edit a GitHub project item",
  description: [
    "Change a project item in one call: field values (fields) and fields to empty (clear_fields), and, for a draft only, its title, body (replaces it) or append_body (adds after a blank line). A value an item already holds, and an empty field to clear, are skipped; if everything is in place nothing is written (changed: []).",
    "Everything is checked before the first write: a field in both fields and clear_fields, body with append_body, a blank title, draft text on an issue or pull request, an unknown field, option or iteration, a bad date and nothing to change are invalid_argument. A write that fails throws, and its message names what was written before it.",
    "An issue's or pull request's own title, body, assignees, labels and milestone are GitHub's, not the board's: github_issue_edit sets them on the issue.",
    FIELDS_NOTE,
    ITEM_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "overwrite",
  targets: { item: "item" },
  input,
  output,
  async execute(args, ctx) {
    const change = parseChange(args)
    const { board, item, draftId } = await resolveBoardItem(args, ctx)
    assertBoardWritable(board)

    const draft = item.content?.type === "draft" ? item.content : undefined
    if (hasDraftText(change) && !draft) {
      throw invalid(
        `title, body and append_body edit a draft's text, but this item is ${contentNoun(item.content)}; change an issue's title and body with github_issue_edit.`,
      )
    }
    if (draft && hasDraftText(change) && !draftId) {
      throw new ToolError("github_error", `GitHub did not return the text of draft ${item.item_id}.`)
    }

    const fields =
      Object.keys(change.values).length > 0 || change.clears.length > 0 ? await readBoardFields(board.id, ctx) : []
    const writes = planFieldValues(fields, change.values).filter(
      (write) => !isHeld(write, item.fields[write.field.name]),
    )
    const clears = planClears(fields, change.clears).filter((field) => !isEmptyValue(item.fields[field.name]))
    const currentBody = draft?.body ?? ""
    const nextBody = change.appendBody === undefined ? change.body : appended(currentBody, change.appendBody)
    const text = {
      title: change.title !== undefined && change.title !== draft?.title ? change.title : undefined,
      body: nextBody !== undefined && nextBody !== currentBody ? nextBody : undefined,
    }

    const changed: string[] = []
    try {
      for (const write of writes) {
        await setFieldValue(board.id, item.item_id, write, ctx)
        changed.push(write.field.name)
      }
      for (const field of clears) {
        await clearFieldValue(board.id, item.item_id, field, ctx)
        changed.push(field.name)
      }
      if (draftId && (text.title !== undefined || text.body !== undefined)) {
        await updateDraft(draftId, text, ctx)
        changed.push(...(["title", "body"] as const).filter((name) => text[name] !== undefined))
      }
    } catch (error) {
      throw withWritten(error, changed)
    }
    return { project: boardSummary(board), item_id: item.item_id, changed }
  },
})
