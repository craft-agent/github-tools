import { rawDraftContent, rawIssueContent, rawItem, statusValue } from "../../testing/board-item-fixtures"
import {
  blockersRule,
  boardWithFields,
  contentRule,
  itemReadRule,
  rawBoardContent,
} from "../../testing/board-write-fixtures"
import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { pullHeadingRule } from "../../testing/pull-request-write-fixtures"
import { ORIGIN, issueHeadingRule, milestonesRule, repositoryRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { projectItemAdd } from "./item-add"
import { projectItemArchive, projectItemUnarchive } from "./item-archive"
import { projectItemConvert } from "./item-convert"
import { projectItemCreate } from "./item-create"
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

/** The title the heading rule gives issue 12 when it is added to the board. */
export const ADDED_TITLE = "Crash on save"

/** An issue 12 or pull request 7 as the board's content query replies with it; `onBoard` puts it on board 3. */
export const addedContent = (type: "Issue" | "PullRequest", onBoard = false) =>
  contentRule(
    rawBoardContent(type, type === "Issue" ? 12 : 7, onBoard ? [["PVTI_1", "PVT_3"]] : [["PVTI_other", "PVT_9"]]),
  )

/** The replies of adding issue 12 to `octo`'s board 3: its fields, its content, its title and its blockers (`states`). */
export const addRules = (onBoard = false, ...states: string[]): GhRule[] => [
  ...boardWithFields(),
  addedContent("Issue", onBoard),
  issueHeadingRule({ title: ADDED_TITLE }),
  blockersRule(...states),
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
  addIssue: {
    name: "add an issue, which starts as Todo",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "12" },
    rules: addRules(),
  },
  addBlockedIssue: {
    name: "add an issue an open issue blocks, which starts as Waiting",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "12" },
    rules: addRules(false, "CLOSED", "OPEN"),
  },
  addWithFields: {
    name: "add an issue with fields, one of them the Status",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "octo/hello#12", fields: { estimate: "3.5", status: "done" } },
    rules: addRules(),
  },
  addPull: {
    name: "add a pull request",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "7" },
    rules: [...boardWithFields(), addedContent("PullRequest"), pullHeadingRule()],
  },
  addExisting: {
    name: "add an issue that is on the board already",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "12" },
    rules: addRules(true),
  },
  addExistingWithFields: {
    name: "add an issue that is on the board already, with a field",
    tool: projectItemAdd,
    args: { project: "octo/3", item: "12", fields: { notes: "Soon" } },
    rules: addRules(true),
  },
  createDraft: {
    name: "create a draft with a body, which starts as Todo",
    tool: projectItemCreate,
    args: { project: "octo/3", title: "  Plan the work  ", body: "Split it in three." },
    rules: boardWithFields(),
  },
  createBare: {
    name: "create a draft with only a title",
    tool: projectItemCreate,
    args: { project: "octo/3", title: "Idea" },
    rules: boardWithFields(),
  },
  createWithFields: {
    name: "create a draft with fields",
    tool: projectItemCreate,
    args: { project: "octo/3", title: "Idea", fields: { estimate: 5, status: "Waiting" } },
    rules: boardWithFields(),
  },
  convertPlain: {
    name: "convert a draft with nothing else",
    tool: projectItemConvert,
    args: { item: "PVTI_1" },
    rules: itemRules(DRAFT_ITEM, repositoryRule()),
  },
  convertFull: {
    name: "convert a draft with a kind, labels and a milestone",
    tool: projectItemConvert,
    args: { item: "PVTI_1", kind: " bug ", labels: ["ui", " ui ", "api"], milestone: "v1" },
    rules: itemRules(DRAFT_ITEM, repositoryRule(), milestonesRule("v0", "V1")),
  },
  convertNewMilestone: {
    name: "convert a draft with a milestone to create",
    tool: projectItemConvert,
    args: { item: "PVTI_1", milestone: "v9", create_milestone: true },
    rules: itemRules(DRAFT_ITEM, repositoryRule(), milestonesRule("v0")),
  },
  convertEmptyDraft: {
    name: "convert a draft that has no body",
    tool: projectItemConvert,
    args: { item: "PVTI_1", labels: ["ui"] },
    rules: itemRules(rawItem("PVTI_1", { ...rawDraftContent("Plan"), id: "DI_1" }), repositoryRule()),
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
