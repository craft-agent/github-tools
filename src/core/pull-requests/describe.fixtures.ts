import { HEAD_SHA, branchRule, defaultBranchRule } from "../../testing/develop-fixtures"
import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { octoBoardRules, viewerRule } from "../../testing/project-fixtures"
import { pullHeadingRule, stateRule } from "../../testing/pull-request-write-fixtures"
import { ORIGIN, milestonesRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { prClose } from "./close"
import { prComment } from "./comment"
import { prCreate } from "./create"
import { prEdit } from "./edit"
import { prReady } from "./ready"
import { prReopen } from "./reopen"
import { prReview } from "./review"

/** One call of a pull request write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The title the heading rule gives pull request 7 unless a case says otherwise. */
export const REAL_TITLE = "Add retry"

/** The replies a create call finds: the default branch `main`, the head branch `feature`, and no open pull request from it yet. */
export const createRules = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  defaultBranchRule("main"),
  branchRule("octo/hello", "main", true),
  branchRule("octo/hello", "feature", true),
  { match: "^pr list", stdout: "[]" },
]

/** The replies a review finds: pull request 7 open and by `someone`, and the viewer `alice`. */
export const reviewRules = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  pullHeadingRule(),
  stateRule(),
  viewerRule("alice"),
]

/** Representative calls of the pull request write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  comment: { name: "comment", tool: prComment, args: { pr: "7", body: "Looks good." }, rules: [pullHeadingRule()] },
  commentOnMerged: {
    name: "comment on a merged pull request",
    tool: prComment,
    args: { pr: "octo/hello#7", body: "Late note." },
    rules: [pullHeadingRule({ state: "MERGED" })],
  },
  commentOnClosed: {
    name: "comment on a closed pull request",
    tool: prComment,
    args: { pr: "7", body: "Closed note." },
    rules: [pullHeadingRule({ state: "CLOSED" })],
  },
  commentAttaching: {
    name: "comment with attachments",
    tool: prComment,
    args: {
      pr: "7",
      body: "See ![the screen](./screen.png).",
      attachments: [{ path: "/tmp/shots/screen.png", alt: "the screen" }, { path: "demo.mp4" }],
    },
    rules: [pullHeadingRule()],
  },
  close: {
    name: "close, with a comment",
    tool: prClose,
    args: { pr: "7", comment: "  Superseded by #9.  " },
    rules: [pullHeadingRule()],
  },
  closeBare: { name: "close without a comment", tool: prClose, args: { pr: "7" }, rules: [pullHeadingRule()] },
  closeClosed: {
    name: "close a pull request that is closed already",
    tool: prClose,
    args: { pr: "7", comment: "Not posted." },
    rules: [pullHeadingRule({ state: "CLOSED" })],
  },
  closeMerged: {
    name: "close a pull request that is merged already",
    tool: prClose,
    args: { pr: "7", comment: "Not posted." },
    rules: [pullHeadingRule({ state: "MERGED" })],
  },
  reopen: {
    name: "reopen, with a comment",
    tool: prReopen,
    args: { pr: "7", comment: "Still needed." },
    rules: [pullHeadingRule({ state: "CLOSED" })],
  },
  reopenOpen: {
    name: "reopen a pull request that is open already",
    tool: prReopen,
    args: { pr: "7", comment: "Not posted." },
    rules: [pullHeadingRule()],
  },
  readyDraft: {
    name: "mark a draft ready",
    tool: prReady,
    args: { pr: "7" },
    rules: [pullHeadingRule({ isDraft: true })],
  },
  readyReady: {
    name: "mark a pull request that is ready already",
    tool: prReady,
    args: { pr: "7" },
    rules: [pullHeadingRule()],
  },
  readyUndo: {
    name: "turn a ready pull request back into a draft",
    tool: prReady,
    args: { pr: "7", undo: true },
    rules: [pullHeadingRule()],
  },
  readyUndoDraft: {
    name: "turn a draft back into a draft",
    tool: prReady,
    args: { pr: "7", undo: true },
    rules: [pullHeadingRule({ isDraft: true })],
  },
  editReplacing: {
    name: "edit replacing the body",
    tool: prEdit,
    args: {
      pr: "7",
      title: "Not the real title",
      body: "Fresh body",
      add_labels: ["bug", "docs"],
      remove_labels: ["wontfix"],
      add_reviewers: ["dave", "octo/core"],
    },
    rules: [pullHeadingRule(), stateRule({ body: "Old body" })],
  },
  editClearing: {
    name: "edit clearing the body and the milestone",
    tool: prEdit,
    args: { pr: "7", body: "", remove_milestone: true, remove_assignees: ["bob"] },
    rules: [pullHeadingRule(), stateRule({ body: "Old body" })],
  },
  editAppending: {
    name: "edit appending to the body, with a milestone and attachments",
    tool: prEdit,
    args: {
      pr: "7",
      append_body: "More details.",
      milestone: "V1",
      add_assignees: ["@me"],
      attachments: [{ path: "/tmp/shots/screen.png" }, { path: "demo.mp4" }],
    },
    rules: [pullHeadingRule(), milestonesRule("v1")],
  },
  editRetargeting: {
    name: "edit retargeting, with closing issues added and removed",
    tool: prEdit,
    args: {
      pr: "7",
      base: "release",
      title: "Retarget",
      add_closes: ["12", "other/thing#3", "#12"],
      remove_closes: ["#5"],
    },
    rules: [pullHeadingRule(), branchRule("octo/hello", "release", true)],
  },
  editMerged: {
    name: "edit a merged pull request",
    tool: prEdit,
    args: { pr: "7", title: "Renamed" },
    rules: [pullHeadingRule({ state: "MERGED" })],
  },
  createPlain: {
    name: "create with only a head and a title",
    tool: prCreate,
    args: { head: "feature", title: "  Add retry  " },
    rules: createRules(),
  },
  createFull: {
    name: "create with every optional piece",
    tool: prCreate,
    args: {
      head: "feature",
      base: "release",
      title: "Add retry",
      body: "Retry three times.",
      draft: true,
      head_sha: HEAD_SHA,
      labels: ["bug", "docs", "bug"],
      milestone: "v1",
      closes: ["12", "other/thing#7", "#12"],
      project: "octo/3",
      attachments: [{ path: "/tmp/shots/screen.png" }, { path: "demo.mp4" }],
    },
    rules: createRules(branchRule("octo/hello", "release", true), milestonesRule("v1"), ...octoBoardRules(3)),
  },
  createPeople: {
    name: "create with reviewers, assignees and labels",
    tool: prCreate,
    args: {
      head: "feature",
      title: "Add retry",
      reviewers: ["dave", "octo/core"],
      assignees: ["alice"],
      labels: ["bug"],
    },
    rules: createRules(),
  },
  reviewApprove: {
    name: "approve, with a body",
    tool: prReview,
    args: { pr: "7", event: "approve", body: "  Ship it.  " },
    rules: reviewRules(),
  },
  reviewApproveBare: {
    name: "approve without a body",
    tool: prReview,
    args: { pr: "7", event: "approve" },
    rules: reviewRules(),
  },
  reviewRequestChanges: {
    name: "request changes",
    tool: prReview,
    args: { pr: "7", event: "request_changes", body: "Needs a test." },
    rules: reviewRules(),
  },
  reviewComments: {
    name: "comment with line comments",
    tool: prReview,
    args: {
      pr: "7",
      event: "comment",
      body: "A few notes.",
      comments: [
        { path: "src/a.ts", line: 12, body: "Why this?" },
        { path: "src/b.ts", start_line: 3, line: 9, side: "left", body: "Remove this block." },
      ],
    },
    rules: [pullHeadingRule()],
  },
  reviewOneComment: {
    name: "comment with one line comment and no body",
    tool: prReview,
    args: { pr: "7", event: "comment", comments: [{ path: "src/a.ts", line: 12, body: "Nit." }] },
    rules: [pullHeadingRule()],
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
