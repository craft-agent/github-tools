import { z } from "zod"
import { planFieldValues } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { addDraftToBoard } from "../github/board-item-write"
import { assertBoardWritable, given, resolveBoard } from "../github/projects"
import { invalid } from "../write-support"
import { StepErrors, defineTool } from "../tool"
import {
  FIELDS_NOTE,
  applyFieldWrites,
  defaultStatusWrite,
  fieldValuesArgument,
  fieldsResultSchema,
  statusToDefault,
  stepErrorsSchema,
} from "./item-support"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...BOARD_SELECTION,
  title: z.string().describe("The draft's title."),
  body: z.string().optional().describe("Markdown body; empty when left out."),
  fields: fieldValuesArgument,
})

const output = z.object({
  project: boardSummarySchema,
  item_id: z.string().describe("The project item's node ID (PVTI_…)."),
  fields: fieldsResultSchema,
  errors: stepErrorsSchema,
})

export const projectItemCreate = defineTool({
  id: "github_project_item_create",
  title: "Create a draft item on a GitHub project",
  description: [
    "Create a draft item (a title and a body that live only on the board, with no repository, labels or milestone) on a project board the viewer may update, and set field values in the same call. github_project_item_convert turns a draft into an issue.",
    "With no Status given the draft starts as Todo when the board has a Status single select with that option.",
    "Once the draft exists, a field that fails to set does not fail the call: it is listed in errors as fields.<Field name>, and the item is still returned.",
    FIELDS_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "add",
  targets: { project: "board" },
  input,
  output,
  async execute(args, ctx) {
    const title = given(args.title)
    if (!title) throw invalid("title cannot be blank.")
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const fields = await readBoardFields(project.id, ctx)
    const writes = planFieldValues(fields, args.fields ?? {})
    const status = statusToDefault(fields, args.fields ?? {})
    if (status) writes.push(...defaultStatusWrite(fields, status, false))

    const itemId = await addDraftToBoard(project.id, { title, body: args.body }, ctx)
    const steps = new StepErrors()
    const set = await applyFieldWrites(project.id, itemId, writes, steps, ctx)
    return { project: boardSummary(project), item_id: itemId, fields: set, errors: steps.errors }
  },
})
