import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { DEPENDENCIES, brief, variable } from "./issue-fixtures"
import { fieldsRule, octoBoardRules } from "./project-fixtures"
import {
  mutationRule,
  queryOf,
  rawField,
  rawIssueFieldDate,
  rawIssueFieldSingleSelect,
  rawOption,
} from "./setup-fixtures"
import { sent } from "./write-fixtures"

/** What GitHub replies with for the board item tools, and a view of the field values and items they wrote. */

const END = "(?: |$)"

export const CONTENT = "issueOrPullRequest"

/** `octo`'s board 3 as a write tool reports it. */
export const BOARD_SUMMARY = {
  number: 3,
  title: "Roadmap",
  url: "https://github.com/orgs/octo/projects/3",
  owner: "octo",
}

export const rawIterationField = (
  id: string,
  name: string,
  iterations: [id: string, title: string, start: string][],
) => ({
  __typename: "ProjectV2IterationField",
  id,
  name,
  dataType: "ITERATION",
  configuration: {
    iterations: iterations.map(([iterationId, title, startDate]) => ({
      id: iterationId,
      title,
      startDate,
      duration: 14,
    })),
  },
})

export const STATUS_OPTIONS = [rawOption("O_todo", "Todo"), rawOption("O_wait", "Waiting"), rawOption("O_done", "Done")]
export const PRIORITY_OPTIONS = [
  rawOption("IFSSO_1", "Urgent", "RED"),
  rawOption("IFSSO_2", "High", "ORANGE"),
  rawOption("IFSSO_3", "Medium", "YELLOW"),
  rawOption("IFSSO_4", "Low", "BLUE"),
]

export const MIRRORED_PRIORITY = rawIssueFieldSingleSelect("F_priority", "Priority", PRIORITY_OPTIONS)
export const MIRRORED_TARGET_DATE = rawIssueFieldDate("F_target_date", "Target date")

/** The fields of a board: GitHub's own, then Status, Priority, a text, a number, a date, Target date and an iteration field. */
export const BOARD_FIELD_NODES = [
  rawField("F_title", "Title", "TITLE"),
  rawField("F_assignees", "Assignees", "ASSIGNEES"),
  rawField("F_milestone", "Milestone", "MILESTONE"),
  rawField("F_status", "Status", "SINGLE_SELECT", STATUS_OPTIONS),
  MIRRORED_PRIORITY,
  rawField("F_notes", "Notes", "TEXT"),
  rawField("F_estimate", "Estimate", "NUMBER"),
  rawField("F_target", "Target", "DATE"),
  MIRRORED_TARGET_DATE,
  rawIterationField("F_sprint", "Sprint", [
    ["IT_1", "Sprint 1", "2026-11-02"],
    ["IT_2", "Sprint 2", "2026-11-16"],
  ]),
]

/** The rules that find `octo`'s board 3 and read its fields, as `project: "octo/3"` names it. */
export const boardWithFields = (
  fields: unknown[] = BOARD_FIELD_NODES,
  extra: Record<string, unknown> = {},
): GhRule[] => [...octoBoardRules(3, extra), fieldsRule(fields)]

/** An issue or pull request as the content query replies with it; `items` are the board items it has: `[id, board node id, archived]`. */
export const rawBoardContent = (
  type: "Issue" | "PullRequest",
  number: number,
  items: [id: string, boardId: string, archived?: boolean][] = [],
) => ({
  __typename: type,
  id: `${type === "Issue" ? "I" : "PR"}_${number}`,
  number,
  url: `https://github.com/octo/hello/${type === "Issue" ? "issues" : "pull"}/${number}`,
  repository: { nameWithOwner: "octo/hello" },
  projectItems: {
    nodes: items.map(([id, boardId, archived]) => ({ id, isArchived: Boolean(archived), project: { id: boardId } })),
  },
})

export const contentRule = (content: unknown): GhRule => ({
  match: CONTENT,
  stdout: gqlReply({ repository: { issueOrPullRequest: content } }),
})

/** The read of one item by its node ID. */
export const itemReadRule = (itemId: string, item: unknown): GhRule => ({
  match: `ProjectV2Item\\{id isArchived[\\s\\S]*id=${itemId}${END}`,
  stdout: gqlReply({ node: item }),
})

/** The issues that block the issue, by state (`OPEN`, `CLOSED`). */
export const blockersRule = (...states: string[]): GhRule => ({
  match: DEPENDENCIES,
  stdout: gqlReply({
    repository: {
      issue: {
        blockedBy: { nodes: states.map((state, index) => brief(50 + index, { state })) },
        blocking: { nodes: [] },
      },
    },
  }),
})

export const addItemRule = (itemId: string): GhRule =>
  mutationRule("addProjectV2ItemById", { addProjectV2ItemById: { item: { id: itemId } } })

export const addDraftRule = (itemId: string): GhRule =>
  mutationRule("addProjectV2DraftIssue", { addProjectV2DraftIssue: { projectItem: { id: itemId } } })

export const setValueRule = (times?: number): GhRule =>
  mutationRule(
    "updateProjectV2ItemFieldValue",
    { updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } },
    times,
  )

export const clearValueRule = (): GhRule =>
  mutationRule("clearProjectV2ItemFieldValue", { clearProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } })

export const updateDraftRule = (): GhRule =>
  mutationRule("updateProjectV2DraftIssue", { updateProjectV2DraftIssue: { draftIssue: { id: "DI_1" } } })

/** One mutation the fake saw, by its name: the variables it was given by name, and its query. */
export type SentMutation = { name: string; query: string; vars: Partial<Record<string, string>> }

/** The GraphQL mutations the fake saw, in order, each with its variables. */
export function mutationsOf(installed: FakeGh): SentMutation[] {
  return sent(installed).flatMap((args) => {
    const query = queryOf(args)
    const name = /^mutation\([^)]*\)\{(\w+)/.exec(query)?.[1]
    if (!name) return []
    const vars = Object.fromEntries(
      ["project", "item", "field", "value", "content", "title", "body", "draft", "repo"].flatMap((key) => {
        const value = variable(args, key)
        return value === undefined ? [] : [[key, value]]
      }),
    )
    return [{ name, query, vars }]
  })
}

/** The names of the mutations the fake saw, in order. */
export const mutationNames = (installed: FakeGh): string[] => mutationsOf(installed).map(({ name }) => name)
