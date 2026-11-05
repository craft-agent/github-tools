import { z } from "zod"
import { planFieldValues } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { addContentToBoard, itemContentRefSchema, readBoardContent } from "../github/board-item-write"
import { readBlockedBy } from "../github/issues"
import { assertBoardWritable, resolveBoard } from "../github/projects"
import { parseNumberRef } from "../refs"
import { StepErrors, defineTool } from "../tool"
import {
  FIELDS_NOTE,
  ITEM_BOARD_SELECTION,
  applyFieldWrites,
  defaultStatusWrite,
  fieldValuesArgument,
  fieldsResultSchema,
  hasWaitingOption,
  statusToDefault,
  stepErrorsSchema,
} from "./item-support"
import { BOARD_LOOKUP_NOTE, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...ITEM_BOARD_SELECTION,
  item: z
    .string()
    .describe(
      "The issue or pull request to put on the board: 12, #12, owner/repo#12 or its URL; a bare number means repo, else the working tree's repository.",
    ),
  fields: fieldValuesArgument,
})

const output = z.object({
  project: boardSummarySchema,
  item_id: z.string().describe("The project item's node ID (PVTI_…)."),
  created: z.boolean().describe("false when the issue or pull request was already on the board."),
  archived: z.boolean().describe("Whether the item is archived; an archived item that was already there stays so."),
  content: itemContentRefSchema,
  fields: fieldsResultSchema,
  errors: stepErrorsSchema,
})

export const projectItemAdd = defineTool({
  id: "github_project_item_add",
  title: "Add an issue or pull request to a GitHub project",
  description: [
    "Put an issue or pull request on a project board the viewer may update, and set field values in the same call. Adding is idempotent: one that is already on the board (archived or not) is returned as it is (created: false) and only the given fields are set.",
    "A new item with no Status given starts as Waiting when it is an issue with an open blocking issue and the board has a Waiting option, else as Todo when the board has that option; a board without a Status single select gets no default.",
    "Once the item is on the board, a field that fails to set does not fail the call: it is listed in errors as fields.<Field name>, and the item is still returned. If the blocking issues cannot be read the item starts as Todo and errors.blocked_by says why.",
    FIELDS_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board" },
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.item, args.repo, ctx)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const fields = await readBoardFields(project.id, ctx)
    const requested = planFieldValues(fields, args.fields ?? {})

    const { id: contentId, items, ...content } = await readBoardContent(ref, ctx)
    const existing = items.find((item) => item.board_id === project.id)
    const steps = new StepErrors()
    const writes = [...requested]
    if (!existing) {
      const status = statusToDefault(fields, args.fields ?? {})
      const waiting =
        status && content.type === "issue" && hasWaitingOption(status)
          ? await steps.record("blocked_by", async () =>
              (await readBlockedBy(ref, ctx)).some((blocker) => blocker.state === "open"),
            )
          : false
      if (status) writes.push(...defaultStatusWrite(fields, status, Boolean(waiting)))
    }

    const itemId = existing?.id ?? (await addContentToBoard(project.id, contentId, ctx))
    const set = await applyFieldWrites(project.id, itemId, writes, steps, ctx)
    return {
      project: boardSummary(project),
      item_id: itemId,
      created: !existing,
      archived: existing?.archived ?? false,
      content,
      fields: set,
      errors: steps.errors,
    }
  },
})
