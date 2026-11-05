import { z } from "zod"
import { ensureField, fieldRequest, FIELD_TYPES } from "../github/board-field-setup"
import { boardFieldSchema, readBoardFields } from "../github/board-fields"
import { OPTION_COLORS } from "../github/board-options"
import { assertBoardWritable, resolveBoard } from "../github/projects"
import { defineTool } from "../tool"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...BOARD_SELECTION,
  name: z.string().describe("The field's name, matched without regard to case."),
  type: z.enum(FIELD_TYPES).describe("The field's type; a field of that name with another type is invalid_argument."),
  options: z
    .array(z.string())
    .optional()
    .describe(
      `single_select only: Name, Name:COLOR or Name:COLOR:Description (the description is everything after the second colon). COLOR is one of ${OPTION_COLORS.join(", ")}, in any case; the default is GRAY.`,
    ),
})

const output = z.object({
  project: boardSummarySchema,
  field: boardFieldSchema.describe("The field as it is now, with its options in order."),
  created: z.boolean().describe("Whether this call made the field."),
  added_options: z.array(z.string()).describe("The names of the options this call added; [] when none."),
})

export const projectFieldEnsure = defineTool({
  id: "github_project_field_ensure",
  title: "Ensure a GitHub project field",
  description: [
    "Make sure a field exists on a project board the viewer may update, without ever making a second one: a missing field is created, and the missing options of an existing single select are appended after its own, which keep their id, name, color, description and order, so nothing already set moves.",
    "A new single_select field needs options. Status can be extended but not created. A field of that name with another type, options on a field that is not single_select, a repeated option name and a color GitHub does not list are invalid_argument, before anything is written.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board" },
  input,
  output,
  async execute(args, ctx) {
    const request = fieldRequest(args.name, args.type, args.options)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const fields = await readBoardFields(project.id, ctx)
    const { field, created, added_options } = await ensureField(project, fields, request, "append", ctx)
    return { project: boardSummary(project), field, created, added_options }
  },
})
