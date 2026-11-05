import { ToolError } from "../errors"
import type { BoardField } from "./board-fields"
import { sameTitle } from "./projects"

/** The options of a single-select field: how they are written as arguments, and how an existing list and a wanted one merge. */

export const OPTION_COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"] as const

export type OptionColor = (typeof OPTION_COLORS)[number]

/** An option as an argument asks for it. */
export type OptionSpec = { name: string; color: OptionColor; description: string }

/** An option as GitHub takes it: one that already exists carries its id, which keeps the items set to it. */
export type OptionInput = { id?: string; name: string; color: string; description: string }

type BoardOption = NonNullable<BoardField["options"]>[number]

/** What a merge made of an existing list and a wanted one. */
export type OptionMerge = {
  options: OptionInput[]
  /** The names of the options that were not on the field. */
  added: string[]
  /** The names of existing options whose name, color, description or place changed. */
  updated: string[]
  /** Whether `options` differs from the existing list. */
  changed: boolean
}

const DEFAULT_COLOR: OptionColor = "GRAY"
const PART_SEPARATOR = ":"

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function splitAt(text: string): [string, string | undefined] {
  const at = text.indexOf(PART_SEPARATOR)
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)]
}

function parseColor(text: string, option: string): OptionColor {
  const color = text.trim().toUpperCase()
  if (!color) return DEFAULT_COLOR
  const known = OPTION_COLORS.find((candidate) => candidate === color)
  if (!known)
    throw invalid(`options: "${option}" has the color "${text.trim()}"; use one of ${OPTION_COLORS.join(", ")}.`)
  return known
}

/**
 * The options an argument lists, each `Name`, `Name:COLOR` or
 * `Name:COLOR:Description` (the description is everything after the second
 * colon). The color is one of GitHub's, in any case, and GRAY when left out.
 * A blank name, a bad color or a name given twice (without regard to case) is
 * `invalid_argument`.
 */
export function parseOptions(options: readonly string[] | undefined): OptionSpec[] {
  const parsed: OptionSpec[] = []
  for (const text of options ?? []) {
    const [rawName, rest = ""] = splitAt(text)
    const [rawColor, rawDescription = ""] = splitAt(rest)
    const name = rawName.trim()
    if (!name) throw invalid(`options: "${text}" has no name.`)
    if (parsed.some((option) => sameTitle(option.name, name))) throw invalid(`options: "${name}" is given twice.`)
    parsed.push({ name, color: parseColor(rawColor, text), description: rawDescription.trim() })
  }
  return parsed
}

function optionIndex(options: readonly BoardOption[], name: string): number {
  return options.findIndex((option) => sameTitle(option.name, name))
}

/** The existing list as it was, then the wanted options it lacks, with their color and description. */
export function appendOptions(existing: readonly BoardOption[], wanted: readonly OptionSpec[]): OptionMerge {
  const missing = wanted.filter((option) => optionIndex(existing, option.name) < 0)
  return {
    options: [...existing, ...missing],
    added: missing.map((option) => option.name),
    updated: [],
    changed: missing.length > 0,
  }
}

/**
 * Exactly the wanted options, in order. One that matches an existing option
 * (without regard to case) keeps that option's id, so the items set to it stay
 * set; the existing ones the list leaves out are dropped.
 */
export function replaceOptions(existing: readonly BoardOption[], wanted: readonly OptionSpec[]): OptionMerge {
  const added: string[] = []
  const updated: string[] = []
  const options = wanted.map((option, place): OptionInput => {
    const at = optionIndex(existing, option.name)
    const old = existing[at]
    if (!old) {
      added.push(option.name)
      return option
    }
    const same =
      at === place && old.name === option.name && old.color === option.color && old.description === option.description
    if (!same) updated.push(option.name)
    return { id: old.id, ...option }
  })
  return {
    options,
    added,
    updated,
    changed: added.length > 0 || updated.length > 0 || existing.length !== wanted.length,
  }
}
