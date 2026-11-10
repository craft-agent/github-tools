import type { ItemContent, ItemFieldValue } from "../github/board-items"
import type { CallHeadline, ToolContext } from "../tool"
import { resolveBoardItem, type ResolvedItem } from "./item-resolve"

/** What a description of a board item tool reads: the board item a call means, found as `execute` finds it. */

/** What a field shows when the item holds no value in it. */
export const NO_VALUE = "—"

/** The board item a call means, as it is now. */
export type DescribedItem = ResolvedItem & {
  /** The real title of the issue, pull request or draft; `undefined` when GitHub returned no content. */
  title: string | undefined
  /** What the item stands for; `undefined` when GitHub returned no content. */
  type: ItemContent["type"] | undefined
}

/**
 * The board item `item` names, resolved exactly as `execute` resolves it, with
 * its board (`board.title`), its real title and content type, and its current
 * field values (`item.fields`). Reads only.
 */
export async function describedItem(
  args: Parameters<typeof resolveBoardItem>[0],
  ctx: ToolContext,
): Promise<DescribedItem> {
  const resolved = await resolveBoardItem(args, ctx)
  const content = resolved.item.content
  return { ...resolved, title: content?.title, type: content?.type }
}

/** The headline of a call on the item, `text` with the item's real title for `{title}`; none when the title is unknown, so the tool's title stands. */
export function itemHeadline(text: string, title: string | undefined): { headline?: CallHeadline } {
  return title === undefined ? {} : { headline: { text, values: { title } } }
}

/** A field value as a fact shows it: a list by its names, an iteration by its title, no value as `NO_VALUE`. */
export function fieldText(value: ItemFieldValue | undefined): string {
  if (value === undefined || value === null) return NO_VALUE
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : NO_VALUE
  if (typeof value === "object") return value.title
  return String(value)
}
