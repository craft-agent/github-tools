import { z } from "zod"
import { gh } from "../gh"
import { readPullRequestState } from "../github/pull-requests"
import { REPO_DESCRIPTION, invalid, writableContext } from "../issues/write-support"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import { PR_DESCRIPTION, PR_TARGETS } from "./write-support"

const OPEN = "open"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  undo: z.boolean().optional().describe("Turn the pull request back into a draft instead of marking it ready."),
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  url: z.string(),
  draft: z.boolean().describe("Whether the pull request is a draft now."),
  changed: z.boolean().describe("False when the pull request was in the asked state already and nothing was sent."),
  foreign: z.boolean(),
})

export const prReady = defineTool({
  id: "github_pr_ready",
  title: "Mark a GitHub pull request ready, or back to draft",
  description: [
    "Mark a draft pull request ready for review, or with undo true turn it back into a draft. Marking it ready notifies the people asked to review it.",
    "A pull request that is in the asked state already is left as it is: nothing is sent and changed is false. Only an open pull request can change; a closed or merged one is an error.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "pull_requests",
  class: "idempotent",
  targets: PR_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const current = await readPullRequestState({ repo: target, number: ref.number }, ctx)
    if (current.state !== OPEN) {
      throw invalid(
        `${target.full}#${ref.number} is ${current.state}; only an open pull request can change between draft and ready.`,
      )
    }

    const draft = Boolean(args.undo)
    const result = { repo: target.full, pr: ref.number, url: current.url, foreign: context.foreign }
    if (current.draft === draft) return { ...result, draft, changed: false }

    await gh(["pr", "ready", String(ref.number), "--repo", target.full, ...(draft ? ["--undo"] : [])], ctx)
    return { ...result, draft, changed: true }
  },
})
