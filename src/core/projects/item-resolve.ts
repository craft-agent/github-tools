import { ToolError } from "../errors"
import { readBoardItem, type BoardItemRead } from "../github/board-items"
import { readBoardContent } from "../github/board-item-write"
import {
  boardResource,
  given,
  isBoardItemId,
  readBoardItemBoard,
  resolveBoard,
  type Board,
  type BoardSelector,
} from "../github/projects"
import { parseNumberRef } from "../refs"
import type { ToolContext } from "../tool"
import { invalid } from "../issues/write-support"

/** Finding the board item a write tool means, and the board it is on. */

/** The board item a call means, as it is now, with the board it sits on. */
export type ResolvedItem = BoardItemRead & { board: Board }

async function readItem(itemId: string, ctx: ToolContext): Promise<BoardItemRead> {
  const read = await readBoardItem(itemId, ctx)
  if (!read) throw new ToolError("not_found", `Project item ${itemId} was not found, or the viewer cannot see it.`)
  return read
}

/**
 * The item `item` names: a project item's node ID (`PVTI_…`), whose board is
 * the one it sits on (as `writeTargets` reads it), or an issue or pull
 * request (`12`, `#12`, `owner/repo#12`, a URL; a bare number takes `repo`,
 * else the working tree's), found among its items on the board the selectors
 * choose. A `project` given beside an ID must name the item's own board, else
 * `invalid_argument`. An item that does not exist, or an issue or pull request
 * that is not on the board, is `not_found`. Reads only.
 */
export async function resolveBoardItem(
  args: BoardSelector & { item: string },
  ctx: ToolContext,
): Promise<ResolvedItem> {
  const value = given(args.item)
  if (!value) {
    throw invalid("item is blank; give a project item's node ID (PVTI_…), or an issue or pull request.")
  }

  if (isBoardItemId(value)) {
    const board = await readBoardItemBoard(value, ctx)
    if (args.project !== undefined) {
      const named = (await resolveBoard(args, ctx)).project
      if (named.id !== board.id) {
        throw invalid(
          `Item ${value} is on ${boardResource(board)}, but project names ${boardResource(named)}; leave project out, or name the board the item is on.`,
        )
      }
    }
    return { ...(await readItem(value, ctx)), board }
  }

  const ref = await parseNumberRef(value, args.repo, ctx)
  const { project: board } = await resolveBoard(args, ctx)
  const content = await readBoardContent(ref, ctx)
  const onBoard = content.items.find((item) => item.board_id === board.id)
  if (!onBoard) {
    throw new ToolError(
      "not_found",
      `${content.repo}#${content.number} is not on ${boardResource(board)} "${board.title}"; add it with github_project_item_add.`,
    )
  }
  return { ...(await readItem(onBoard.id, ctx)), board }
}
