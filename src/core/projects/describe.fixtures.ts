import { rawDraftContent, rawIssueContent, rawItem, statusValue } from "../../testing/board-item-fixtures"
import { boardWithFields, contentRule, itemReadRule, rawBoardContent } from "../../testing/board-write-fixtures"
import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { ORIGIN } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { projectItemArchive, projectItemUnarchive } from "./item-archive"
import { projectItemEdit } from "./item-edit"

/** One call of a project board write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The title of the issue item, which the tools show instead of any title a call gives. */
export const ISSUE_TITLE = "Issue 12"
/** The title of the draft item. */
export const DRAFT_TITLE = "Plan"
/** The body of the draft item. */
export const DRAFT_BODY = "Old\n"

const sprint = (title: string) => ({ title, startDate: "2026-11-02", duration: 14, field: { name: "Sprint" } })

/** An issue item holding Status Todo, Estimate 3, Notes "Old" and Sprint 1. */
export const ISSUE_ITEM = rawItem("PVTI_1", rawIssueContent(12), [
  statusValue("Todo"),
  { number: 3, field: { name: "Estimate" } },
  { text: "Old", field: { name: "Notes" } },
  sprint("Sprint 1"),
])

/** A draft item titled `DRAFT_TITLE` with the body `DRAFT_BODY`. */
export const DRAFT_ITEM = rawItem("PVTI_1", { ...rawDraftContent(DRAFT_TITLE, DRAFT_BODY), id: "DI_1" })

/** An issue item with no field values, archived or not. */
export const archivedItem = (archived: boolean) => rawItem("PVTI_1", rawIssueContent(12), [], { isArchived: archived })

/** The rules that find item `PVTI_1` on `octo`'s board 3 (as `ID` names it) and read it as `item`. */
export const itemRules = (item: unknown, ...rules: GhRule[]): GhRule[] => [
  itemBoardRule("PVTI_1", rawBoard(3)),
  itemReadRule("PVTI_1", item),
  ...rules,
]

/** Representative calls of the board item write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  editFields: {
    name: "edit field values, skipping one the item holds",
    tool: projectItemEdit,
    args: {
      item: "PVTI_1",
      fields: { status: "done", estimate: 4, notes: "Old", sprint: "sprint 2", target: "2026-12-01" },
    },
    rules: itemRules(ISSUE_ITEM, ...boardWithFields()),
  },
  editClearing: {
    name: "edit clearing fields, one of which is empty",
    tool: projectItemEdit,
    args: { item: "PVTI_1", clear_fields: ["NOTES", "Target"] },
    rules: itemRules(ISSUE_ITEM, ...boardWithFields()),
  },
  editByReference: {
    name: "edit an issue named by its reference",
    tool: projectItemEdit,
    args: { item: "octo/hello#12", project: "octo/3", fields: { Status: "Waiting" } },
    rules: [
      ...boardWithFields(),
      contentRule(rawBoardContent("Issue", 12, [["PVTI_1", "PVT_3"]])),
      itemReadRule("PVTI_1", ISSUE_ITEM),
    ],
  },
  editInPlace: {
    name: "edit with every value in place already",
    tool: projectItemEdit,
    args: { item: "PVTI_1", fields: { Status: "Todo", Estimate: "3" }, clear_fields: ["Target"] },
    rules: itemRules(ISSUE_ITEM, ...boardWithFields()),
  },
  editDraftReplacing: {
    name: "edit a draft replacing the title and the body",
    tool: projectItemEdit,
    args: { item: "PVTI_1", title: "  Plan v2  ", body: "New body", fields: { Status: "Done" } },
    rules: itemRules(DRAFT_ITEM, ...boardWithFields()),
  },
  editDraftClearing: {
    name: "edit a draft clearing the body",
    tool: projectItemEdit,
    args: { item: "PVTI_1", body: "" },
    rules: itemRules(DRAFT_ITEM),
  },
  editDraftAppending: {
    name: "edit a draft appending to the body",
    tool: projectItemEdit,
    args: { item: "PVTI_1", append_body: "More" },
    rules: itemRules(DRAFT_ITEM),
  },
  editDraftInPlace: {
    name: "edit a draft whose text is in place already",
    tool: projectItemEdit,
    args: { item: "PVTI_1", title: DRAFT_TITLE, body: DRAFT_BODY },
    rules: itemRules(DRAFT_ITEM),
  },
  archive: {
    name: "archive an item",
    tool: projectItemArchive,
    args: { item: "PVTI_1" },
    rules: itemRules(archivedItem(false)),
  },
  archiveByReference: {
    name: "archive an issue named by its reference",
    tool: projectItemArchive,
    args: { item: "12", project: "octo/3" },
    rules: [
      ...octoBoardRules(3),
      contentRule(rawBoardContent("Issue", 12, [["PVTI_1", "PVT_3"]])),
      itemReadRule("PVTI_1", archivedItem(false)),
    ],
  },
  archiveArchived: {
    name: "archive an item that is archived already",
    tool: projectItemArchive,
    args: { item: "PVTI_1" },
    rules: itemRules(archivedItem(true)),
  },
  unarchive: {
    name: "unarchive an item",
    tool: projectItemUnarchive,
    args: { item: "PVTI_1" },
    rules: itemRules(archivedItem(true)),
  },
  unarchiveActive: {
    name: "unarchive an item that is not archived",
    tool: projectItemUnarchive,
    args: { item: "PVTI_1" },
    rules: itemRules(archivedItem(false)),
  },
} satisfies Record<string, DescribeCase>

/**
 * Describes a case in a throwaway working tree whose origin is `octo/hello`,
 * with the fake `gh` it needs; `seen` gets the arguments of every call the
 * description made to `gh`.
 */
export async function describeCase(
  item: DescribeCase,
  seen?: (calls: string[][]) => void,
): Promise<CallDescription | undefined> {
  const repo = tempRepo(ORIGIN)
  const fake = installFakeGh(item.rules)
  try {
    return await callDescription(item.tool, item.args, { cwd: repo.dir })
  } finally {
    seen?.(fake.calls())
    fake.restore()
    repo.cleanup()
  }
}
