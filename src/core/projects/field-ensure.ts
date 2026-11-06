import { z } from "zod"
import { ToolError } from "../errors"
import {
  ensureField,
  ensureIssueFieldColumn,
  fieldRequest,
  issueFieldColumnRequest,
  readOwnerIssueFields,
  FIELD_TYPES,
  type FieldOutcome,
} from "../github/board-field-setup"
import { boardFieldSchema, readBoardFields, type BoardField } from "../github/board-fields"
import { OPTION_COLORS } from "../github/board-options"
import { assertBoardWritable, resolveBoard, type Board } from "../github/projects"
import type { RefContext } from "../refs"
import { defineTool } from "../tool"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...BOARD_SELECTION,
  name: z.string().describe("The field's name, matched without regard to case."),
  type: z
    .enum(FIELD_TYPES)
    .optional()
    .describe(
      "The field's type; a field of that name with another type is invalid_argument. Required unless issue_field is true, where it only checks the issue field's type.",
    ),
  options: z
    .array(z.string())
    .optional()
    .describe(
      `single_select only, not with issue_field: Name, Name:COLOR or Name:COLOR:Description (the description is everything after the second colon). COLOR is one of ${OPTION_COLORS.join(", ")}, in any case; the default is GRAY.`,
    ),
  issue_field: z
    .boolean()
    .optional()
    .describe(
      "Add a column that mirrors the organization's issue field of that name instead of a field of the board's own; its options and values are the organization's and the issue's.",
    ),
})

const output = z.object({
  project: boardSummarySchema,
  field: boardFieldSchema.describe("The field as it is now, with its options in order."),
  created: z.boolean().describe("Whether this call made the field."),
  added_options: z.array(z.string()).describe("The names of the options this call added; [] when none."),
})

/**
 * Checks the arguments before GitHub is asked and returns what to do with the board once it is found:
 * make the board's own field of that type, or add the column that mirrors the organization's issue field.
 */
function planEnsure(
  args: z.output<typeof input>,
): (board: Board, fields: BoardField[], ctx: RefContext) => Promise<FieldOutcome> {
  if (args.issue_field) {
    if (args.options && args.options.length > 0) {
      throw new ToolError("invalid_argument", "options are the organization's with issue_field; leave them out.")
    }
    const request = issueFieldColumnRequest(args.name, args.type)
    return async (board, fields, ctx) =>
      ensureIssueFieldColumn(board, fields, await readOwnerIssueFields(board, ctx), request, ctx)
  }
  if (!args.type) throw new ToolError("invalid_argument", "type is required unless issue_field is true.")
  const request = fieldRequest(args.name, args.type, args.options)
  return (board, fields, ctx) => ensureField(board, fields, request, "append", ctx)
}

export const projectFieldEnsure = defineTool({
  id: "github_project_field_ensure",
  title: "Ensure a GitHub project field",
  description: [
    "Make sure a field exists on a project board the viewer may update, without ever making a second one: a missing field is created, and the missing options of an existing single select are appended after its own, which keep their id, name, color, description and order, so nothing already set moves.",
    "A new single_select field needs options. Status can be extended but not created. A field of that name with another type, options on a field that is not single_select, a repeated option name and a color GitHub does not list are invalid_argument, before anything is written.",
    "With issue_field: true (organization boards only) the column mirrors the organization's issue field of that name, such as Priority, Start date or Target date; it is added when the board lacks it, and a field of the board's own with that name is invalid_argument.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board" },
  input,
  output,
  async execute(args, ctx) {
    const ensure = planEnsure(args)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const fields = await readBoardFields(project.id, ctx)
    const { field, created, added_options } = await ensure(project, fields, ctx)
    return { project: boardSummary(project), field, created, added_options }
  },
})
