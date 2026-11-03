import { z } from "zod"
import { gh } from "../gh"
import { readIssueFields } from "../github/issues"
import { ghIssueRef, resolveRelatedIssue } from "../github/issue-refs"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { ISSUE_DESCRIPTION, REPO_DESCRIPTION, given, invalid, writableContext } from "./write-support"

const REASONS = ["completed", "not_planned", "duplicate"] as const

type Reason = (typeof REASONS)[number]

/** How `gh issue close --reason` spells each reason. */
const GH_REASONS: Record<Reason, string> = {
  completed: "completed",
  not_planned: "not planned",
  duplicate: "duplicate",
}

const CLOSED = "closed"

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  reason: z.enum(REASONS).describe("Why it is closed."),
  comment: z.string().optional().describe("A comment to post as the issue closes."),
  duplicate_of: z
    .string()
    .optional()
    .describe("With reason duplicate: the issue it duplicates, as 12, #12, owner/repo#12 or its URL."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  state_reason: z.enum(REASONS).nullable().describe("The reason the issue is closed with now."),
  changed: z.boolean().describe("False when the issue was closed already and nothing was sent."),
  foreign: z.boolean(),
})

export const issueClose = defineTool({
  id: "github_issue_close",
  title: "Close a GitHub issue",
  description: [
    "Close an issue with a reason: completed, not_planned or duplicate (duplicate_of names the original, in the same forms as an issue). The comment, if any, is posted as it closes, and the people following the issue are notified.",
    "An issue that is closed already is left as it is: nothing is sent, the comment is not posted, changed is false and state_reason is its current reason.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "issues",
  class: "overwrite",
  input,
  output,
  async execute(args, ctx) {
    const duplicateOf = given(args.duplicate_of)
    if (duplicateOf && args.reason !== "duplicate") {
      throw invalid('duplicate_of goes with reason "duplicate"; leave it out, or close the issue as a duplicate.')
    }
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const original = duplicateOf ? await resolveRelatedIssue(duplicateOf, ref.repo, ctx) : undefined
    if (
      original &&
      original.number === ref.number &&
      original.repo.full.toLowerCase() === ref.repo.full.toLowerCase()
    ) {
      throw invalid("An issue cannot be a duplicate of itself.")
    }

    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const current = await readIssueFields({ repo: target, number: ref.number }, ctx)
    if (current.state === CLOSED) {
      return {
        repo: target.full,
        issue: ref.number,
        // Any other reason GitHub reports (a reopened issue has its own) is not one this tool closes with.
        state_reason: REASONS.find((reason) => reason === current.state_reason) ?? null,
        changed: false,
        foreign: context.foreign,
      }
    }

    const flags = ["--reason", GH_REASONS[args.reason]]
    const comment = given(args.comment)
    if (comment) flags.push("--comment", comment)
    if (original) flags.push("--duplicate-of", ghIssueRef(original, target))
    await gh(["issue", "close", String(ref.number), "--repo", target.full, ...flags], ctx)
    return { repo: target.full, issue: ref.number, state_reason: args.reason, changed: true, foreign: context.foreign }
  },
})
