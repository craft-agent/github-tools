import { z } from "zod"
import { gh } from "../gh"
import { readIssueFields } from "../github/issues"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { ISSUE_DESCRIPTION, ISSUE_TARGETS, describedIssue } from "./write-support"
import { REPO_DESCRIPTION, given, writableContext } from "../write-support"

const OPEN = "open"

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  comment: z.string().optional().describe("A comment to post as the issue reopens."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  changed: z.boolean().describe("False when the issue was open already and nothing was sent."),
  foreign: z.boolean(),
})

export const issueReopen = defineTool({
  id: "github_issue_reopen",
  title: "Reopen a GitHub issue",
  intent: "About to reopen a GitHub issue",
  description: [
    "Reopen a closed issue; the comment, if any, is posted as it reopens, and the people following the issue are notified.",
    "An issue that is open already is left as it is: nothing is sent, the comment is not posted and changed is false.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "issues",
  class: "overwrite",
  targets: ISSUE_TARGETS,
  async describe(args, ctx) {
    const { heading } = await describedIssue(args, ctx)
    const headline = { text: "About to reopen the issue {title}", values: { title: heading.title } }
    if (heading.state === OPEN) {
      return { headline, facts: [{ label: "State", value: { text: "Already open; nothing is sent" } }] }
    }

    const comment = given(args.comment)
    return {
      headline,
      facts: [],
      ...(comment ? { text: { label: "Comment", body: comment } } : {}),
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const current = await readIssueFields({ repo: target, number: ref.number }, ctx)
    if (current.state === OPEN)
      return { repo: target.full, issue: ref.number, changed: false, foreign: context.foreign }

    const comment = given(args.comment)
    await gh(
      ["issue", "reopen", String(ref.number), "--repo", target.full, ...(comment ? ["--comment", comment] : [])],
      ctx,
    )
    return { repo: target.full, issue: ref.number, changed: true, foreign: context.foreign }
  },
})
