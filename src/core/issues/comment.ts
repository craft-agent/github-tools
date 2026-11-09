import { z } from "zod"
import { gh } from "../gh"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { stateFact } from "../write-facts"
import { ISSUE_DESCRIPTION, ISSUE_TARGETS, describedIssue } from "./write-support"
import { REPO_DESCRIPTION, given, invalid, lastUrl, writableContext } from "../write-support"

const CLOSED = "closed"

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  body: z.string().describe("The comment, in Markdown."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  url: z.string().describe("The new comment's URL."),
  foreign: z.boolean(),
})

export const issueComment = defineTool({
  id: "github_issue_comment",
  title: "Comment on a GitHub issue",
  intent: "About to comment on a GitHub issue",
  description: [
    "Post a comment on an issue; the people following it are notified and the comment stays on the issue.",
    "Needs write permission on the repository.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "issues",
  class: "add",
  targets: ISSUE_TARGETS,
  async describe(args, ctx) {
    const { heading } = await describedIssue(args, ctx)
    return {
      headline: { text: "About to comment on the issue {title}", values: { title: heading.title } },
      facts: heading.state === CLOSED ? [stateFact(heading.state)] : [],
      text: { label: "Comment", body: args.body },
    }
  },
  input,
  output,
  async execute(args, ctx) {
    if (!given(args.body)) throw invalid("body cannot be blank.")
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const context = await writableContext(ref.repo, ctx)
    const stdout = await gh(["issue", "comment", String(ref.number), "--repo", context.repo.full, "--body-file", "-"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      stdin: args.body,
    })
    return {
      repo: context.repo.full,
      issue: ref.number,
      url: lastUrl(stdout) ?? "",
      foreign: context.foreign,
    }
  },
})
