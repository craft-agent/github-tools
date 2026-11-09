import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { octoBoardRules } from "../../testing/project-fixtures"
import { ORIGIN, issueFieldsRule, issueHeadingRule, milestonesRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { issueClose } from "./close"
import { issueComment } from "./comment"
import { issueCreate } from "./create"
import { issueEdit } from "./edit"
import { issueReopen } from "./reopen"

/** One call of an issue write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The title the heading rule gives issue 12 unless a case says otherwise. */
export const REAL_TITLE = "Crash on save"

const closed = (stateReason: string | null = null) => issueHeadingRule({ state: "CLOSED", stateReason })

/** Representative calls of the seven issue write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  comment: { name: "comment", tool: issueComment, args: { issue: "12", body: "Thanks!" }, rules: [issueHeadingRule()] },
  commentOnClosed: {
    name: "comment on a closed issue",
    tool: issueComment,
    args: { issue: "octo/hello#12", body: "Late note." },
    rules: [closed("COMPLETED")],
  },
  closeCompleted: {
    name: "close as completed, with a comment",
    tool: issueClose,
    args: { issue: "12", reason: "completed", comment: "  Shipped in v2.  " },
    rules: [issueHeadingRule()],
  },
  closeNotPlanned: {
    name: "close as not planned",
    tool: issueClose,
    args: { issue: "12", reason: "not_planned" },
    rules: [issueHeadingRule()],
  },
  closeDuplicate: {
    name: "close as a duplicate",
    tool: issueClose,
    args: { issue: "12", reason: "duplicate", duplicate_of: "#5" },
    rules: [issueHeadingRule()],
  },
  closeDuplicateElsewhere: {
    name: "close as a duplicate of an issue elsewhere",
    tool: issueClose,
    args: { issue: "12", reason: "duplicate", duplicate_of: "other/thing#7" },
    rules: [issueHeadingRule()],
  },
  closeClosed: {
    name: "close an issue that is closed already",
    tool: issueClose,
    args: { issue: "12", reason: "not_planned", comment: "Not posted.", duplicate_of: "5" },
    rules: [closed("COMPLETED")],
  },
  reopen: {
    name: "reopen, with a comment",
    tool: issueReopen,
    args: { issue: "12", comment: "Still happens." },
    rules: [closed("COMPLETED")],
  },
  reopenOpen: {
    name: "reopen an issue that is open already",
    tool: issueReopen,
    args: { issue: "12", comment: "Not posted." },
    rules: [issueHeadingRule()],
  },
  editReplacing: {
    name: "edit replacing the body",
    tool: issueEdit,
    args: {
      issue: "12",
      title: "Not the real title",
      body: "Fresh body",
      add_labels: ["bug", "docs"],
      remove_labels: ["wontfix"],
      add_assignees: ["@me"],
    },
    rules: [issueHeadingRule(), issueFieldsRule({ body: "Old body" })],
  },
  editClearing: {
    name: "edit clearing the body and the milestone",
    tool: issueEdit,
    args: { issue: "12", body: "", remove_milestone: true, remove_assignees: ["bob"] },
    rules: [issueHeadingRule(), issueFieldsRule({ body: "Old body" })],
  },
  editAppending: {
    name: "edit appending to the body, with a new milestone, a kind and issue fields",
    tool: issueEdit,
    args: {
      issue: "12",
      append_body: "More details.",
      milestone: "v2",
      create_milestone: true,
      kind: "bug",
      issue_fields: { Priority: "High" },
      clear_issue_fields: ["Sprint"],
    },
    rules: [issueHeadingRule(), milestonesRule("v1")],
  },
  editMilestone: {
    name: "edit into an existing milestone, named in other letters",
    tool: issueEdit,
    args: { issue: "12", milestone: "V1" },
    rules: [issueHeadingRule(), milestonesRule("v1")],
  },
  createPlain: { name: "create with only a title", tool: issueCreate, args: { title: "  Add retry  " }, rules: [] },
  createFull: {
    name: "create with every optional piece",
    tool: issueCreate,
    args: {
      title: "Add retry",
      body: "Retry three times.",
      kind: "bug",
      labels: ["bug", "docs", "bug"],
      assignees: ["alice"],
      milestone: "v1",
      parent: "5",
      blocked_by: ["6", "other/thing#7", " ", "6"],
      issue_fields: { Priority: "High" },
      project: "octo/3",
    },
    rules: [milestonesRule("v1"), ...octoBoardRules(3)],
  },
  createNewMilestone: {
    name: "create with a milestone it makes",
    tool: issueCreate,
    args: { title: "Plan", milestone: "v9", create_milestone: true },
    rules: [milestonesRule("v1")],
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
