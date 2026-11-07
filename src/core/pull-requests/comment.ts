import { z } from "zod"
import {
  ATTACHMENTS_NOTE,
  attachmentsArgument,
  attachmentsResultSchema,
  prepareAttachments,
  sentAttachments,
} from "../attachments"
import { ATTACH_MIN_GH_VERSION, ensureGhAtLeast, gh } from "../gh"
import { REPO_DESCRIPTION, given, invalid, lastUrl, writableContext } from "../write-support"
import { stepErrorsSchema } from "../projects/item-support"
import { parseNumberRef } from "../refs"
import { StepErrors, defineTool } from "../tool"
import { PR_DESCRIPTION, PR_TARGETS, settleUpload } from "./write-support"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  body: z.string().describe("The comment, in Markdown."),
  attachments: attachmentsArgument,
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  url: z.string().describe("The new comment's URL."),
  attachments: attachmentsResultSchema,
  notes: z.array(z.string()).describe("What to know about the result; [] when nothing."),
  foreign: z.boolean(),
  errors: stepErrorsSchema,
})

export const prComment = defineTool({
  id: "github_pr_comment",
  title: "Comment on a GitHub pull request",
  description: [
    "Post a comment on a pull request; the people following it are notified and the comment stays on the pull request.",
    "Needs write permission on the repository.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
    ATTACHMENTS_NOTE,
  ].join(" "),
  toolset: "pull_requests",
  class: "add",
  targets: PR_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    if (!given(args.body)) throw invalid("body cannot be blank.")
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const attached = Boolean(args.attachments?.length)
    if (attached) await ensureGhAtLeast(ATTACH_MIN_GH_VERSION, "attachments", ctx.signal)
    const context = await writableContext(ref.repo, ctx)

    const steps = new StepErrors()
    const prepared = await prepareAttachments(args.attachments, ctx)
    try {
      const stdout = await settleUpload(
        () =>
          gh(
            ["pr", "comment", String(ref.number), "--repo", context.repo.full, "--body-file", "-", ...prepared.flags],
            { cwd: ctx.cwd, signal: ctx.signal, stdin: prepared.rewriteBody(args.body) },
          ),
        attached,
        steps,
      )
      return {
        repo: context.repo.full,
        pr: ref.number,
        url: lastUrl(stdout) ?? "",
        attachments: sentAttachments(prepared),
        notes: prepared.notes,
        foreign: context.foreign,
        errors: steps.errors,
      }
    } finally {
      await prepared.cleanup()
    }
  },
})
