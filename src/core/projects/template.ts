import { STATUS_FIELD, type FieldRequest } from "../github/board-field-setup"
import type { ViewRequest } from "../github/board-view-setup"

/** The standard template a board is brought to: Status, Start and Target, and the Roadmap, Kanban and Backlog views. */

/** The Status options a new board item starts in: `Todo`, or `Waiting` when an open issue blocks it. */
export const STATUS_TODO = "Todo"
export const STATUS_WAITING = "Waiting"

/** How a board's Start and Target dates are set up: board fields or mirrored issue fields. */
export const DATE_MODES = ["board", "issue_fields"] as const

export type DateMode = (typeof DATE_MODES)[number]

/** The date column names when using the board's own date fields. */
export const BOARD_DATE_FIELDS = { start: "Start", target: "Target" } as const

/** The date column names when mirroring the organization's issue date fields. */
export const ISSUE_DATE_FIELDS = { start: "Start date", target: "Target date" } as const

/** The name GitHub gives a new board's only view. */
export const DEFAULT_VIEW_NAME = "View 1"

/** Said when the call made the Roadmap view, whose date fields only the web UI can set. */
export function roadmapNote(dates: { start: string; target: string }): string {
  return `Set the Roadmap view's date fields to ${dates.start} and ${dates.target} in the web UI; the API cannot set them.`
}

/** The roadmap note when using board-mode date fields. */
export const ROADMAP_NOTE = roadmapNote(BOARD_DATE_FIELDS)

/** The standard Status field request with its five options. */
export const STATUS_REQUEST: FieldRequest = {
  name: STATUS_FIELD,
  type: "single_select",
  options: [
    { name: STATUS_TODO, color: "BLUE", description: "Ready to start; nothing is in the way." },
    { name: "In Progress", color: "YELLOW", description: "Being worked on now." },
    {
      name: STATUS_WAITING,
      color: "GRAY",
      description: "Cannot move until something else clears: an open blocking issue, a review or a reply.",
    },
    { name: "Done", color: "PURPLE", description: "Finished." },
    { name: "Cancelled", color: "RED", description: "Will not be done; kept for the record." },
  ],
}

/** Builds the standard views and roadmap note from the two date column names. */
export function standardTemplate(dates: { start: string; target: string }): {
  views: ViewRequest[]
  roadmapNote: string
} {
  const notDone = "-status:Done -status:Cancelled"
  return {
    roadmapNote: roadmapNote(dates),
    views: [
      { name: "Roadmap", layout: "roadmap", filter: "-status:Cancelled", sort_by: dates.start },
      {
        name: "Kanban",
        layout: "board",
        filter: notDone,
        column_by: STATUS_FIELD,
        fields: ["Title", "Assignees", "Repository", "Parent issue", dates.target],
        sort_by: dates.target,
      },
      {
        name: "Backlog",
        layout: "table",
        filter: notDone,
        fields: [
          "Title",
          STATUS_FIELD,
          "Assignees",
          "Repository",
          "Milestone",
          "Parent issue",
          "Sub-issues progress",
          dates.start,
          dates.target,
          "Linked pull requests",
        ],
        group_by: STATUS_FIELD,
        sort_by: dates.target,
      },
    ],
  }
}
