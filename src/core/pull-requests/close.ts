import { z } from "zod"
import { gh } from "../gh"
import { readPullRequestState } from "../github/pull-requests"
import { REPO_DESCRIPTION, given, writableContext } from "../write-support"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { PR_DESCRIPTION, PR_TARGETS } from "./write-support"

const OPEN = "open"
const CLOSED = "closed"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  comment: z.string().optional().describe("A comment to post as the pull request closes."),
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  url: z.string(),
  state: z.string().describe("closed, or merged for a pull request that was merged already."),
  changed: z.boolean().describe("False when the pull request was closed or merged already and nothing was sent."),
  foreign: z.boolean(),
})

export const prClose = defineTool({
  id: "github_pr_close",
  title: "Close a GitHub pull request",
  description: [
    "Close a pull request without merging it; its branch is not deleted. The comment, if any, is posted as it closes, and the people following the pull request are notified.",
    "A pull request that is closed or merged already is left as it is: nothing is sent, the comment is not posted, changed is false and state says which.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "pull_requests",
  class: "overwrite",
  targets: PR_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const current = await readPullRequestState({ repo: target, number: ref.number }, ctx)
    const result = { repo: target.full, pr: ref.number, url: current.url, foreign: context.foreign }
    if (current.state !== OPEN) return { ...result, state: current.state, changed: false }

    const comment = given(args.comment)
    await gh(
      ["pr", "close", String(ref.number), "--repo", target.full, ...(comment ? ["--comment", comment] : [])],
      ctx,
    )
    return { ...result, state: CLOSED, changed: true }
  },
})
