import { z } from "zod"
import { setFieldValue } from "../github/board-item-write"
import { planFieldValues, type FieldValue, type FieldWrite } from "../github/board-field-values"
import { STATUS_FIELD } from "../github/board-field-setup"
import type { BoardField } from "../github/board-fields"
import type { ItemContent } from "../github/board-items"
import { sameTitle } from "../github/projects"
import type { RefContext } from "../refs"
import type { StepErrors } from "../tool"
import { BOARD_SELECTION } from "./support"
import { STATUS_TODO, STATUS_WAITING } from "./template"

/** What the board item tools share: their arguments and results, setting field values as steps, and the Status a new item starts in. */

/** The board selectors of a tool that also names an issue or pull request, where `repo` also settles a bare number. */
export const ITEM_BOARD_SELECTION = {
  ...BOARD_SELECTION,
  repo: z
    .string()
    .optional()
    .describe(
      "owner/name; defaults to the working tree's repository (its origin). Where the board lookup starts, the owner of a bare board number, and the repository of a bare issue or pull request number.",
    ),
}

export const itemArgument = z
  .string()
  .describe(
    "The board item: its node ID (PVTI_…), or an issue or pull request as 12, #12, owner/repo#12 or its URL, found on the board that project, owner and repo choose. A draft can only be named by its ID.",
  )

export const ITEM_NOTE =
  "An item is named by its node ID (PVTI_…), which also tells its board (a project given beside it must be that board), or by an issue or pull request (12, #12, owner/repo#12 or its URL) that is on the board the lookup finds. A draft can only be named by its ID."

export const FIELDS_NOTE =
  "Field values are set by field name and option or iteration name, matched without regard to case: text as a string, number as a number or numeric string, date as YYYY-MM-DD, single select as an option name, iteration as an iteration title or @current (the iteration containing today, UTC). Only text, number, date, single select and iteration fields can be set; a column that mirrors an issue field is set with the issue tools' issue_fields, not here. GitHub's own (Title, Assignees, Labels, Milestone, Repository, Linked pull requests, …) are set on the issue, and github_issue_edit sets assignees, labels and milestone. Every field and value is checked before anything is written."

export const fieldValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]))

export const fieldValuesArgument = fieldValuesSchema
  .optional()
  .describe(
    'Field values to set, by field name: {"Status": "Todo", "Target": "2026-12-01"}. Values are text, a number, a YYYY-MM-DD date, an option name or an iteration title (@current is the one containing today). A column that mirrors an issue field is set with the issue tools\' issue_fields, not here.',
  )

export const fieldsResultSchema = fieldValuesSchema.describe(
  "The values that were set, by field name as the board spells it: an option or iteration by its name, a number as a number.",
)

export const stepErrorsSchema = z
  .record(z.string(), z.string())
  .describe("Failed steps, keyed by step (fields.<Field name>, blocked_by, kind, labels, milestone); {} when none.")

/** What an item stands for, in words for an error message. */
export function contentNoun(content: ItemContent | null): string {
  switch (content?.type) {
    case "draft":
      return "a draft"
    case "issue":
      return "an issue"
    case "pr":
      return "a pull request"
    default:
      return "an item without readable content"
  }
}

/**
 * Sets each checked value on the item, every one a step of its own named
 * `fields.<Field name>`, so a failure is reported under `errors` and the
 * others still land. Returns the values that were set.
 */
export async function applyFieldWrites(
  projectId: string,
  itemId: string,
  writes: readonly FieldWrite[],
  steps: StepErrors,
  ctx: RefContext,
): Promise<Record<string, FieldValue>> {
  const set: Record<string, FieldValue> = {}
  for (const write of writes) {
    const done = await steps.record(`fields.${write.field.name}`, async () => {
      await setFieldValue(projectId, itemId, write, ctx)
      return true
    })
    if (done) set[write.field.name] = write.shown
  }
  return set
}

function hasOption(field: BoardField, name: string): boolean {
  return (field.options ?? []).some((option) => sameTitle(option.name, name))
}

/**
 * The Status field a new item gets a starting value in: the board's single
 * select named Status, unless the caller's values already set a field of that
 * name. `undefined` when there is none to give, or the caller chose.
 */
export function statusToDefault(
  fields: readonly BoardField[],
  given: Readonly<Record<string, FieldValue>>,
): BoardField | undefined {
  const status = fields.find((field) => field.type === "single_select" && sameTitle(field.name, STATUS_FIELD))
  return status && !Object.keys(given).some((name) => sameTitle(name, status.name)) ? status : undefined
}

/** Whether the board has an option that marks a new item as waiting, which makes an item's blockers worth reading. */
export function hasWaitingOption(status: BoardField): boolean {
  return hasOption(status, STATUS_WAITING)
}

/** The write that gives a new item its starting Status: `Waiting` when it is `waiting` and the board has it, else `Todo` when the board has it; none otherwise. */
export function defaultStatusWrite(fields: readonly BoardField[], status: BoardField, waiting: boolean): FieldWrite[] {
  const name = [waiting ? STATUS_WAITING : undefined, STATUS_TODO].find(
    (option) => option !== undefined && hasOption(status, option),
  )
  return name === undefined ? [] : planFieldValues(fields, { [status.name]: name })
}
