import { z } from "zod"
import { gh } from "../gh"
import { readPullRequestState } from "../github/pull-requests"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../issues/write-support"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { PR_DESCRIPTION, PR_TARGETS } from "./write-support"

const OPEN = "open"
const MERGED = "merged"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  comment: z.string().optional().describe("A comment to post as the pull request reopens."),
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  url: z.string(),
  state: z.string().describe("The pull request's state now: open."),
  changed: z.boolean().describe("False when the pull request was open already and nothing was sent."),
  foreign: z.boolean(),
})

export const prReopen = defineTool({
  id: "github_pr_reopen",
  title: "Reopen a GitHub pull request",
  description: [
    "Reopen a closed pull request; the comment, if any, is posted as it reopens, and the people following the pull request are notified. A merged pull request cannot be reopened.",
    "A pull request that is open already is left as it is: nothing is sent, the comment is not posted and changed is false.",
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
    if (current.state === MERGED) {
      throw invalid(`${target.full}#${ref.number} is merged; a merged pull request cannot be reopened.`)
    }
    const result = { repo: target.full, pr: ref.number, url: current.url, state: OPEN, foreign: context.foreign }
    if (current.state === OPEN) return { ...result, changed: false }

    const comment = given(args.comment)
    await gh(
      ["pr", "reopen", String(ref.number), "--repo", target.full, ...(comment ? ["--comment", comment] : [])],
      ctx,
    )
    return { ...result, changed: true }
  },
})
