import { z } from "zod"
import {
  ATTACHMENTS_NOTE,
  attachmentsArgument,
  attachmentsResultSchema,
  prepareAttachments,
  sentAttachments,
} from "../attachments"
import { isAbortError } from "../errors"
import { ATTACH_MIN_GH_VERSION, ensureGhAtLeast } from "../gh"
import { branchHead, defaultBranch } from "../github/branches"
import type { IssueRef } from "../github/issue-refs"
import { milestoneSchema, resolveMilestone, type MilestoneRef } from "../github/milestones"
import { closingIssueSchema, readPullRequestState, type PullRequestState } from "../github/pull-requests"
import { REPO_DESCRIPTION, appended, given, invalid, lastUrl, nameList, writableContext } from "../write-support"
import { stepErrorsSchema } from "../projects/item-support"
import { parseNumberRef } from "../refs"
import { StepErrors, defineTool } from "../tool"
import { CLOSES_DESCRIPTION, splitClosingBlock, withClosing } from "./closes"
import {
  PR_DESCRIPTION,
  PR_TARGETS,
  closingNotes,
  editPullRequest,
  resolveClosing,
  settleUpload,
  settledClosingState,
  type ClosingChange,
  type ClosingState,
} from "./write-support"

const MERGED = "merged"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  title: z.string().optional().describe("The new title."),
  body: z.string().optional().describe("The new body, which replaces the whole old one; empty clears it."),
  append_body: z.string().optional().describe("Text added after the current body, set off by a blank line."),
  base: z.string().optional().describe("The branch of the repository to merge into; not for a merged pull request."),
  add_labels: z.array(z.string()).optional().describe("Labels to add; they must exist."),
  remove_labels: z.array(z.string()).optional(),
  add_assignees: z.array(z.string()).optional().describe('Logins, or "@me".'),
  remove_assignees: z.array(z.string()).optional(),
  add_reviewers: z
    .array(z.string())
    .optional()
    .describe("Logins, or org/team, to request a review from; they are notified."),
  remove_reviewers: z.array(z.string()).optional(),
  milestone: z.string().optional().describe("A milestone title to set; it must exist."),
  remove_milestone: z.boolean().optional().describe("Take the pull request out of its milestone."),
  add_closes: z.array(z.string()).optional().describe(CLOSES_DESCRIPTION.add_closes),
  remove_closes: z.array(z.string()).optional().describe(CLOSES_DESCRIPTION.remove_closes),
  attachments: attachmentsArgument,
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  url: z.string(),
  changed: z.array(z.string()).describe("The arguments that were applied."),
  milestone: milestoneSchema
    .nullable()
    .describe("The milestone that was set; null when none was set or it was removed."),
  closing_issues: z
    .array(closingIssueSchema)
    .optional()
    .describe(
      "The issues GitHub links as closed by the pull request now; only when add_closes or remove_closes was given.",
    ),
  attachments: attachmentsResultSchema,
  notes: z.array(z.string()).describe("What to know about the result; [] when nothing."),
  foreign: z.boolean(),
  errors: stepErrorsSchema,
})

type Args = z.output<typeof input>

/** The arguments of one edit, checked and cleaned up. */
type Change = {
  title?: string
  body?: string
  appendBody?: string
  base?: string
  addLabels: string[]
  removeLabels: string[]
  addAssignees: string[]
  removeAssignees: string[]
  addReviewers: string[]
  removeReviewers: string[]
  milestone?: string
  removeMilestone: boolean
  addCloses: IssueRef[]
  removeCloses: IssueRef[]
  attachments: boolean
}

function refuseOverlap(what: string, added: readonly string[], removed: readonly string[]): void {
  const removing = new Set(removed.map((name) => name.toLowerCase()))
  const both = added.filter((name) => removing.has(name.toLowerCase()))
  if (both.length) throw invalid(`${what} ${both.join(", ")} cannot be both added and removed.`)
}

const labelOf = (issue: IssueRef): string => `${issue.repo.full}#${issue.number}`

/** Refuses what cannot describe one edit, before any call to GitHub. */
function parseChange(args: Args, closes: { add: IssueRef[]; remove: IssueRef[] }): Change {
  const appendBody = given(args.append_body) === undefined ? undefined : args.append_body
  if (args.body !== undefined && appendBody !== undefined) {
    throw invalid("body replaces the whole body and append_body adds to it; pass one of them.")
  }
  const title = given(args.title)
  if (args.title !== undefined && !title) throw invalid("title is blank; pass the new title, or leave it out.")
  const base = given(args.base)
  if (args.base !== undefined && !base) throw invalid("base is blank; pass the branch to merge into, or leave it out.")
  const milestone = given(args.milestone)
  if (args.milestone !== undefined && !milestone) {
    throw invalid(
      "milestone is blank; pass its title, or remove_milestone to take the pull request out of its milestone.",
    )
  }
  const removeMilestone = Boolean(args.remove_milestone)
  if (milestone && removeMilestone)
    throw invalid("milestone and remove_milestone contradict each other; pass one of them.")

  const change: Change = {
    title,
    body: args.body,
    appendBody,
    base,
    addLabels: nameList("add_labels", args.add_labels),
    removeLabels: nameList("remove_labels", args.remove_labels),
    addAssignees: nameList("add_assignees", args.add_assignees),
    removeAssignees: nameList("remove_assignees", args.remove_assignees),
    addReviewers: nameList("add_reviewers", args.add_reviewers),
    removeReviewers: nameList("remove_reviewers", args.remove_reviewers),
    milestone,
    removeMilestone,
    addCloses: closes.add,
    removeCloses: closes.remove,
    attachments: Boolean(args.attachments?.length),
  }
  refuseOverlap("Label", change.addLabels, change.removeLabels)
  refuseOverlap("Assignee", change.addAssignees, change.removeAssignees)
  refuseOverlap("Reviewer", change.addReviewers, change.removeReviewers)
  refuseOverlap("Closing issue", change.addCloses.map(labelOf), change.removeCloses.map(labelOf))
  if (changedArguments(change).length === 0) {
    throw invalid(
      "Nothing to change: pass at least one of title, body, append_body, base, labels, assignees, reviewers, milestone, closes or attachments.",
    )
  }
  return change
}

/** The arguments an edit applies, in the order the tool lists them. */
function changedArguments(change: Change): string[] {
  const applied: Record<string, boolean> = {
    title: change.title !== undefined,
    body: change.body !== undefined,
    append_body: change.appendBody !== undefined,
    base: change.base !== undefined,
    add_labels: change.addLabels.length > 0,
    remove_labels: change.removeLabels.length > 0,
    add_assignees: change.addAssignees.length > 0,
    remove_assignees: change.removeAssignees.length > 0,
    add_reviewers: change.addReviewers.length > 0,
    remove_reviewers: change.removeReviewers.length > 0,
    milestone: change.milestone !== undefined,
    remove_milestone: change.removeMilestone,
    add_closes: change.addCloses.length > 0,
    remove_closes: change.removeCloses.length > 0,
    attachments: change.attachments,
  }
  return Object.entries(applied).flatMap(([name, isApplied]) => (isApplied ? [name] : []))
}

export const prEdit = defineTool({
  id: "github_pr_edit",
  title: "Edit a GitHub pull request",
  intent: "About to edit a GitHub pull request",
  description: [
    "Change a pull request in one call: title, body (body replaces it, append_body adds after a blank line), base branch (not for a merged pull request), labels, assignees and reviewers to add or remove (added assignees and reviewers are notified), milestone or remove_milestone, and the issues it closes (add_closes adds a `Closes #12` line to the body, remove_closes removes such lines).",
    "A milestone that does not exist is an error. Needs write permission on the repository.",
    "append_body goes before the closing lines (Closes #12) the body ends with, so those stay the last lines.",
    "After closing issues change, the call waits up to a few seconds for GitHub to link them, then lists closing_issues as GitHub links them and notes say when one is not linked (a pull request into a branch other than the default branch links none; otherwise it may link it a moment later) or is still linked (another form of mention in the body or a commit message).",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
    ATTACHMENTS_NOTE,
  ].join(" "),
  toolset: "pull_requests",
  class: "overwrite",
  targets: PR_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const change = parseChange(args, {
      add: await resolveClosing(args.add_closes, ref.repo, ctx),
      remove: await resolveClosing(args.remove_closes, ref.repo, ctx),
    })
    if (change.attachments) await ensureGhAtLeast(ATTACH_MIN_GH_VERSION, "attachments", ctx.signal)
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const pull = { repo: target, number: ref.number }
    const closesChanged = change.addCloses.length > 0 || change.removeCloses.length > 0

    // Reading the pull request also proves it exists, before anything depends on it.
    const needsRead = change.appendBody !== undefined || closesChanged || change.base !== undefined
    const current: PullRequestState | undefined = needsRead ? await readPullRequestState(pull, ctx) : undefined
    if (current && change.base !== undefined) {
      if (current.state === MERGED) {
        throw invalid(`${target.full}#${ref.number} is merged; the base of a merged pull request cannot be changed.`)
      }
      if (change.base === current.head) {
        throw invalid(`base ${change.base} is the head branch of ${target.full}#${ref.number}; pass another branch.`)
      }
      if ((await branchHead(target, change.base, ctx)) === null) {
        throw invalid(`base branch "${change.base}" is not on ${target.full}.`)
      }
    }
    const milestone: MilestoneRef | null = change.milestone
      ? await resolveMilestone(target, change.milestone, { create: false, creatable: false }, ctx)
      : null
    // Read before the write, so a failure here cannot follow a change that is made already.
    const fallback = closesChanged ? await defaultBranch(target, ctx) : null

    // Appended text goes before the closing lines the body ends with, which stay the last lines.
    let sent = change.body
    if (change.appendBody !== undefined) {
      const { text, block } = splitClosingBlock(current?.body ?? "", target)
      const withText = appended(text, change.appendBody)
      sent = block ? `${withText}\n\n${block}` : withText
    }
    const body = closesChanged
      ? withClosing(sent ?? current?.body ?? "", change.addCloses, change.removeCloses, target)
      : sent

    const steps = new StepErrors()
    const prepared = await prepareAttachments(args.attachments, ctx)
    let stdout: string
    try {
      const flags: string[] = []
      if (change.title) flags.push("--title", change.title)
      if (body !== undefined) flags.push("--body-file", "-")
      if (change.base) flags.push("--base", change.base)
      for (const label of change.addLabels) flags.push("--add-label", label)
      for (const label of change.removeLabels) flags.push("--remove-label", label)
      for (const assignee of change.addAssignees) flags.push("--add-assignee", assignee)
      for (const assignee of change.removeAssignees) flags.push("--remove-assignee", assignee)
      for (const reviewer of change.addReviewers) flags.push("--add-reviewer", reviewer)
      for (const reviewer of change.removeReviewers) flags.push("--remove-reviewer", reviewer)
      if (milestone) flags.push("--milestone", milestone.title)
      if (change.removeMilestone) flags.push("--remove-milestone")
      flags.push(...prepared.flags)
      const sentBody = body === undefined ? undefined : prepared.rewriteBody(body)
      stdout = await settleUpload(
        () => editPullRequest(target, ref.number, flags, ctx, sentBody),
        change.attachments,
        steps,
      )
    } finally {
      await prepared.cleanup()
    }

    const result = {
      repo: target.full,
      pr: ref.number,
      url: lastUrl(stdout) ?? `https://github.com/${target.full}/pull/${ref.number}`,
      changed: changedArguments(change),
      milestone,
      attachments: sentAttachments(prepared),
      foreign: context.foreign,
      errors: steps.errors,
    }
    if (!closesChanged) return { ...result, notes: prepared.notes }

    // The edit is made, so a failed read-back is told in a note instead of failing the call.
    try {
      const closes: ClosingChange = { add: change.addCloses, remove: change.removeCloses }
      const first = await readPullRequestState(pull, ctx)
      const after = await settledClosingState(first, closes, { pull, defaultBranch: fallback }, ctx)
      const state: ClosingState = {
        ...closes,
        base: after.base,
        defaultBranch: fallback,
        linked: after.closing_issues,
      }
      return { ...result, closing_issues: after.closing_issues, notes: [...prepared.notes, ...closingNotes(state)] }
    } catch (error) {
      if (isAbortError(error)) throw error
      const why = error instanceof Error ? error.message : String(error)
      return {
        ...result,
        notes: [...prepared.notes, `The closing issues could not be read back after the edit: ${why}`],
      }
    }
  },
})
