import { STATUS_FIELD, type FieldRequest } from "../github/board-field-setup"
import type { ViewRequest } from "../github/board-view-setup"

/** The standard template a board is brought to: Status, Start and Target, and the Roadmap, Kanban and Backlog views. */

/** The Status options a new board item starts in: `Todo`, or `Waiting` when an open issue blocks it. */
export const STATUS_TODO = "Todo"
export const STATUS_WAITING = "Waiting"

const START_FIELD = "Start"
const TARGET_FIELD = "Target"
const NOT_DONE = "-status:Done -status:Cancelled"

/** The name GitHub gives a new board's only view. */
export const DEFAULT_VIEW_NAME = "View 1"

/** Said when the call made the Roadmap view, whose date fields only the web UI can set. */
export const ROADMAP_NOTE =
  "Set the Roadmap view's date fields to Start and Target in the web UI; the API cannot set them."

export const STANDARD_FIELDS: readonly FieldRequest[] = [
  {
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
  },
  { name: START_FIELD, type: "date", options: [] },
  { name: TARGET_FIELD, type: "date", options: [] },
]

/** In the order they are made. */
export const STANDARD_VIEWS: readonly ViewRequest[] = [
  { name: "Roadmap", layout: "roadmap", filter: "-status:Cancelled", sort_by: START_FIELD },
  {
    name: "Kanban",
    layout: "board",
    filter: NOT_DONE,
    column_by: STATUS_FIELD,
    fields: ["Title", "Assignees", "Repository", "Parent issue", TARGET_FIELD],
    sort_by: TARGET_FIELD,
  },
  {
    name: "Backlog",
    layout: "table",
    filter: NOT_DONE,
    fields: [
      "Title",
      STATUS_FIELD,
      "Assignees",
      "Repository",
      "Milestone",
      "Parent issue",
      "Sub-issues progress",
      START_FIELD,
      TARGET_FIELD,
      "Linked pull requests",
    ],
    group_by: STATUS_FIELD,
    sort_by: TARGET_FIELD,
  },
]
