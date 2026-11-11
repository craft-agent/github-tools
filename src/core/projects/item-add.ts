import { z } from "zod"
import { planFieldValues } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { addContentToBoard, itemContentRefSchema, readBoardContent } from "../github/board-item-write"
import { isAbortError } from "../errors"
import { readBlockedBy, readIssueHeading } from "../github/issues"
import { assertBoardWritable, resolveBoard } from "../github/projects"
import { readPullRequestHeading } from "../github/pull-requests"
import { parseNumberRef, type RepoName } from "../refs"
import { githubTargets } from "../github/targets"
import { StepErrors, defineTool, type ToolContext } from "../tool"
import { fieldsFact } from "./describe-support"
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

/** How the `State` fact words an item that is on the board already and gets no field values. */
const ALREADY_ON_BOARD = "Already on the board; nothing is sent"

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

/** Whether an open issue blocks the issue; blockers that cannot be read count as none, as `execute` takes them. */
async function isBlocked(ref: { repo: RepoName; number: number }, ctx: ToolContext): Promise<boolean> {
  try {
    return (await readBlockedBy(ref, ctx)).some((blocker) => blocker.state === "open")
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    return false
  }
}

export const projectItemAdd = defineTool({
  id: "github_project_item_add",
  title: "Add an issue or pull request to a GitHub project",
  intent: "About to add an issue or pull request to a GitHub project",
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
  targets: githubTargets({ project: "board" }),
  async describe(args, ctx) {
    const ref = await parseNumberRef(args.item, args.repo, ctx)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const fields = await readBoardFields(project.id, ctx)
    const writes = planFieldValues(fields, args.fields ?? {})

    const { items, type } = await readBoardContent(ref, ctx)
    const existing = items.some((item) => item.board_id === project.id)
    const { title } = type === "issue" ? await readIssueHeading(ref, ctx) : await readPullRequestHeading(ref, ctx)
    const headline = { text: "About to add {title} to the project board", values: { title } }
    if (existing && writes.length === 0) {
      return { headline, facts: [{ label: "State", value: { text: ALREADY_ON_BOARD } }] }
    }
    if (!existing) {
      const status = statusToDefault(fields, args.fields ?? {})
      const waiting = status && type === "issue" && hasWaitingOption(status) ? await isBlocked(ref, ctx) : false
      if (status) writes.push(...defaultStatusWrite(fields, status, waiting))
    }

    const fieldsText = fieldsFact(writes)
    return {
      headline,
      facts: [{ label: "Board", value: project.title }, ...(fieldsText ? [fieldsText] : [])],
    }
  },
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
