import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { pullHeadingRule } from "../../testing/pull-request-write-fixtures"
import { ORIGIN } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { prClose } from "./close"
import { prComment } from "./comment"
import { prReady } from "./ready"
import { prReopen } from "./reopen"

/** One call of a pull request write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The title the heading rule gives pull request 7 unless a case says otherwise. */
export const REAL_TITLE = "Add retry"

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
