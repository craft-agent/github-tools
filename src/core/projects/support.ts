import { z } from "zod"
import { DEFAULT_BOARD_TITLE, boardSchema, type Board } from "../github/projects"

/** What the board write tools share: the arguments that choose a board, how a board is reported, and the token scope they need. */

export const BOARD_SELECTION = {
  project: z
    .string()
    .optional()
    .describe(
      `The board, as its number, owner/number or its URL (used as it is; a bare number takes owner, else the owner of repo or of the working tree's repository), or as its title, looked up among open boards (whole title, case-insensitive). Default: the title ${DEFAULT_BOARD_TITLE}.`,
    ),
  owner: z
    .string()
    .optional()
    .describe(
      'A user or organization login, or "@me": the owner of a numbered board, else the only owner searched for a title.',
    ),
  repo: z
    .string()
    .optional()
    .describe(
      "owner/name; defaults to the working tree's repository (its origin). Where the board lookup starts, and the owner of a bare board number.",
    ),
}

export const BOARD_LOOKUP_NOTE =
  "A board is named by project: its number, owner/number or its URL, used as it is; any other project is a title, and no project is Roadmap: the open board of that whole title is looked up, never guessed, in owner's boards if owner is given, else in the boards linked to repo, then its organization's, then the viewer's."

export const PROJECT_SCOPE_NOTE =
  "Needs a token with the project scope; if GitHub reports missing scopes, run gh auth refresh -s project."

export const boardSummarySchema = boardSchema.pick({ number: true, title: true, url: true, owner: true })

/** The board as a write tool reports it. */
export function boardSummary(board: Board): z.output<typeof boardSummarySchema> {
  return { number: board.number, title: board.title, url: board.url, owner: board.owner }
}
