import { z } from "zod"
import { setItemArchived } from "../github/board-item-write"
import { assertBoardWritable } from "../github/projects"
import { defineTool, type ToolContext } from "../tool"
import { ITEM_BOARD_SELECTION, ITEM_NOTE, itemArgument } from "./item-support"
import { resolveBoardItem } from "./item-resolve"
import { BOARD_LOOKUP_NOTE, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({ item: itemArgument, ...ITEM_BOARD_SELECTION })

const output = z.object({
  project: boardSummarySchema,
  item_id: z.string(),
  archived: z.boolean().describe("Whether the item is archived now."),
  changed: z.boolean().describe("false when the item was already in the wanted state."),
})

type Args = z.output<typeof input>

/** Puts the item in the wanted state, writing only when it is not in it. */
async function setArchived(args: Args, archived: boolean, ctx: ToolContext) {
  const { board, item } = await resolveBoardItem(args, ctx)
  assertBoardWritable(board)
  const changed = item.archived !== archived
  if (changed) await setItemArchived(board.id, item.item_id, archived, ctx)
  return { project: boardSummary(board), item_id: item.item_id, archived, changed }
}

export const projectItemArchive = defineTool({
  id: "github_project_item_archive",
  title: "Archive a GitHub project item",
  description: [
    "Archive an item on a project board the viewer may update: it leaves the board's views and github_project_read's item_list unless include_archived, and github_project_item_unarchive brings it back. Nothing is deleted. An item that is already archived is left as it is (changed: false).",
    ITEM_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "overwrite",
  targets: { item: "item" },
  input,
  output,
  execute: (args, ctx) => setArchived(args, true, ctx),
})

export const projectItemUnarchive = defineTool({
  id: "github_project_item_unarchive",
  title: "Unarchive a GitHub project item",
  description: [
    "Bring an archived item back onto a project board the viewer may update, with its field values. An item that is not archived is left as it is (changed: false).",
    ITEM_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "overwrite",
  targets: { item: "item" },
  input,
  output,
  execute: (args, ctx) => setArchived(args, false, ctx),
})
