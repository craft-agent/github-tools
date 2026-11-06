import { ToolError } from "../errors"
import type { BoardField } from "./board-fields"
import type { ItemFieldValue } from "./board-items"
import { sameTitle } from "./projects"

/** Checking field values against a board's fields before anything is written, and comparing them with what an item holds. */

/** A field value as a caller gives it. */
export type FieldValue = string | number

/** The types of field a board item's value can be set in; every other field is GitHub's own. */
const SETTABLE_TYPES = ["text", "number", "date", "single_select", "iteration"] as const

type SettableType = (typeof SETTABLE_TYPES)[number]
type SettableField = BoardField & { type: SettableType }

/** The own fields whose values come from the issue, which `github_issue_edit` changes. */
const ISSUE_FIELD_TYPES: readonly string[] = ["assignees", "labels", "milestone"]

/** What names the iteration that contains today. */
export const CURRENT_ITERATION = "@current"

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/

/** A value checked against its field, ready to be written. */
export type FieldWrite = {
  field: BoardField
  kind: SettableType
  /** What goes to GitHub: the text, the number, the date, or the ID of the option or iteration. */
  sent: string | number
  /** The value as a result reports it: the option's or iteration's name in the board's spelling, the number as a number. */
  shown: FieldValue
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function isSettable(type: string): type is SettableType {
  return (SETTABLE_TYPES as readonly string[]).includes(type)
}

/** Names quoted and comma-separated for an error message; "none" for an empty list. */
export function listOf(names: readonly string[]): string {
  return names.length > 0 ? names.map((name) => `"${name}"`).join(", ") : "none"
}

function settableNames(fields: readonly BoardField[]): string {
  return listOf(fields.filter((field) => isSettable(field.type) && !field.issue_field).map((field) => field.name))
}

/** The field of the board with this name (without regard to case), once it is one whose value can be set. */
function settableField(fields: readonly BoardField[], name: string, action: "set" | "clear" = "set"): SettableField {
  const field = fields.find((candidate) => sameTitle(candidate.name, name))
  if (!field) throw invalid(`The board has no field "${name}". Fields that can be set: ${settableNames(fields)}.`)
  if (field.issue_field) {
    const verb = action === "clear" ? "cleared" : "set"
    const fix =
      action === "clear"
        ? "Clear it with clear_issue_fields in github_issue_edit."
        : "Set it with issue_fields in github_issue_edit or github_issue_create."
    throw invalid(
      `"${field.name}" mirrors the organization's issue field; its value is the issue's own and cannot be ${verb} on a board. ${fix} Fields that can be set: ${settableNames(fields)}.`,
    )
  }
  if (!isSettable(field.type)) {
    const hint = ISSUE_FIELD_TYPES.includes(field.type)
      ? " github_issue_edit sets assignees, labels and milestone on the issue."
      : ""
    throw invalid(
      `"${field.name}" is one of GitHub's own fields; its value cannot be set on a board item.${hint} Fields that can be set: ${settableNames(fields)}.`,
    )
  }
  return field as SettableField
}

/** The text of a value for the field named `field`; a number is refused. `what` says what the field takes. */
export function textOf(field: string, value: FieldValue, what: string): string {
  if (typeof value !== "string") {
    throw invalid(`"${field}" takes ${what} as text; got the number ${value}. Pass it as a string.`)
  }
  return value
}

/** The number of a value for the field named `field`: a number, or a string that is one. */
export function numberOf(field: string, value: FieldValue): number {
  const text = typeof value === "string" ? value.trim() : undefined
  const number =
    typeof value === "number" ? value : text !== undefined && NUMBER_PATTERN.test(text) ? Number(text) : NaN
  if (!Number.isFinite(number)) throw invalid(`"${field}" takes a number; got ${JSON.stringify(value)}.`)
  return number
}

/** The `YYYY-MM-DD` of a value for the field named `field`; a date that does not exist is refused. */
export function dateOf(field: string, value: FieldValue): string {
  const text = textOf(field, value, "a date").trim()
  const parsed = DATE_PATTERN.test(text) ? new Date(`${text}T00:00:00Z`) : undefined
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(`"${field}" takes a date as YYYY-MM-DD; got ${JSON.stringify(value)}.`)
  }
  return text
}

function optionOf(field: BoardField, value: FieldValue): FieldWrite {
  const name = textOf(field.name, value, "an option name")
  const options = field.options ?? []
  const option = options.find((candidate) => sameTitle(candidate.name, name))
  if (!option) {
    throw invalid(`"${field.name}" has no option "${name}". Options: ${listOf(options.map((each) => each.name))}.`)
  }
  return { field, kind: "single_select", sent: option.id, shown: option.name }
}

/** The iteration that contains `now` (UTC), among those the field lists. */
function currentIteration(iterations: NonNullable<BoardField["iterations"]>, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return iterations.find((iteration) => {
    const start = Date.parse(iteration.start_date)
    return start <= today && today < start + iteration.duration * DAY_MS
  })
}

function iterationOf(field: BoardField, value: FieldValue, now: Date): FieldWrite {
  const title = textOf(field.name, value, "an iteration title").trim()
  const iterations = field.iterations ?? []
  const iteration =
    title.toLowerCase() === CURRENT_ITERATION
      ? currentIteration(iterations, now)
      : iterations.find((candidate) => sameTitle(candidate.title, title))
  if (!iteration) {
    const reason = title.toLowerCase() === CURRENT_ITERATION ? "No iteration contains today" : `No iteration "${title}"`
    throw invalid(
      `${reason} in "${field.name}". Iterations: ${listOf(iterations.map((each) => each.title))}, or ${CURRENT_ITERATION}.`,
    )
  }
  return { field, kind: "iteration", sent: iteration.id, shown: iteration.title }
}

function planValue(field: SettableField, value: FieldValue, now: Date): FieldWrite {
  switch (field.type) {
    case "text": {
      const text = textOf(field.name, value, "text")
      return { field, kind: "text", sent: text, shown: text }
    }
    case "number": {
      const number = numberOf(field.name, value)
      return { field, kind: "number", sent: number, shown: number }
    }
    case "date": {
      const date = dateOf(field.name, value)
      return { field, kind: "date", sent: date, shown: date }
    }
    case "single_select":
      return optionOf(field, value)
    case "iteration":
      return iterationOf(field, value, now)
  }
}

/**
 * Checks every value against the board's fields, by field name (without
 * regard to case): the field exists and is one whose value can be set, the
 * option or iteration exists (`@current` is the iteration containing today,
 * UTC), a date is a real `YYYY-MM-DD`, a number is a number, and no field is
 * named twice. Anything else is `invalid_argument` naming the valid choices.
 */
export function planFieldValues(
  fields: readonly BoardField[],
  values: Readonly<Record<string, FieldValue>>,
  now: Date = new Date(),
): FieldWrite[] {
  const writes: FieldWrite[] = []
  for (const [name, value] of Object.entries(values)) {
    const field = settableField(fields, name, "set")
    if (writes.some((write) => write.field.id === field.id)) {
      throw invalid(`fields names "${field.name}" twice; field names are matched without regard to case.`)
    }
    writes.push(planValue(field, value, now))
  }
  return writes
}

/** The fields to clear, each once, once they are checked to be ones whose value can be set. */
export function planClears(fields: readonly BoardField[], names: readonly string[]): BoardField[] {
  const cleared: BoardField[] = []
  for (const name of names) {
    const field = settableField(fields, name, "clear")
    if (!cleared.some((each) => each.id === field.id)) cleared.push(field)
  }
  return cleared
}

/** Whether an item has no value in a field. */
export function isEmptyValue(current: ItemFieldValue | undefined): boolean {
  return current === undefined || current === null
}

/** Whether an item already holds the value of the write, so writing it again would change nothing. */
export function isHeld(write: FieldWrite, current: ItemFieldValue | undefined): boolean {
  const held = typeof current === "object" && current !== null && "title" in current ? current.title : current
  return held === write.shown
}
