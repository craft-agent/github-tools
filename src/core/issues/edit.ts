import { z } from "zod"
import { readIssueFields } from "../github/issues"
import {
  kindFlags,
  kindPlacementSchema,
  otherKindLabels,
  resolveKind,
  withKindFallback,
  type KindPlacement,
} from "../github/kind"
import { milestoneSchema, resolveMilestone, type MilestoneRef } from "../github/milestones"
import { parseNumberRef } from "../refs"
import { defineTool } from "../tool"
import {
  ISSUE_DESCRIPTION,
  ISSUE_TARGETS,
  REPO_DESCRIPTION,
  editIssue,
  given,
  invalid,
  lastUrl,
  nameList,
  writableContext,
} from "./write-support"

const BODY_SEPARATOR = "\n\n"

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  title: z.string().optional().describe("The new title."),
  body: z.string().optional().describe("The new body, which replaces the whole old one; empty clears it."),
  append_body: z.string().optional().describe("Text added after the current body, set off by a blank line."),
  kind: z
    .string()
    .optional()
    .describe(
      "Such as bug: the organization's Issue Type of that name, else the type:<kind> label, replacing other type: labels.",
    ),
  add_labels: z.array(z.string()).optional().describe("Labels to add; they must exist."),
  remove_labels: z.array(z.string()).optional(),
  add_assignees: z.array(z.string()).optional().describe('Logins, or "@me".'),
  remove_assignees: z.array(z.string()).optional(),
  milestone: z.string().optional().describe("A milestone title to set."),
  remove_milestone: z.boolean().optional().describe("Take the issue out of its milestone."),
  create_milestone: z.boolean().optional().describe("Create the milestone when it does not exist; needs milestone."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  url: z.string(),
  changed: z.array(z.string()).describe("The arguments that were applied."),
  kind: kindPlacementSchema.nullable().describe("Where the kind landed; null when none was given."),
  milestone: milestoneSchema
    .nullable()
    .describe("The milestone that was set; null when none was set or it was removed."),
  foreign: z.boolean(),
})

type Args = z.output<typeof input>

/** The arguments of one edit, checked and cleaned up. */
type Change = {
  title?: string
  body?: string
  appendBody?: string
  kind?: string
  addLabels: string[]
  removeLabels: string[]
  addAssignees: string[]
  removeAssignees: string[]
  milestone?: string
  removeMilestone: boolean
  createMilestone: boolean
}

function refuseOverlap(what: string, added: readonly string[], removed: readonly string[]): void {
  const removing = new Set(removed.map((name) => name.toLowerCase()))
  const both = added.filter((name) => removing.has(name.toLowerCase()))
  if (both.length) throw invalid(`${what} ${both.join(", ")} cannot be both added and removed.`)
}

/** Refuses what cannot describe one edit, before any call to GitHub. */
function parseChange(args: Args): Change {
  const appendBody = given(args.append_body) === undefined ? undefined : args.append_body
  if (args.body !== undefined && appendBody !== undefined) {
    throw invalid("body replaces the whole body and append_body adds to it; pass one of them.")
  }
  const title = given(args.title)
  if (args.title !== undefined && !title) throw invalid("title is blank; pass the new title, or leave it out.")
  const milestone = given(args.milestone)
  if (args.milestone !== undefined && !milestone) {
    throw invalid("milestone is blank; pass its title, or remove_milestone to take the issue out of its milestone.")
  }
  const removeMilestone = Boolean(args.remove_milestone)
  if (milestone && removeMilestone)
    throw invalid("milestone and remove_milestone contradict each other; pass one of them.")
  const createMilestone = Boolean(args.create_milestone)
  if (createMilestone && !milestone) throw invalid("create_milestone needs milestone.")

  const [kind] = nameList("kind", args.kind === undefined ? [] : [args.kind])
  const change: Change = {
    title,
    body: args.body,
    appendBody,
    kind,
    addLabels: nameList("add_labels", args.add_labels),
    removeLabels: nameList("remove_labels", args.remove_labels),
    addAssignees: nameList("add_assignees", args.add_assignees),
    removeAssignees: nameList("remove_assignees", args.remove_assignees),
    milestone,
    removeMilestone,
    createMilestone,
  }
  refuseOverlap("Label", change.addLabels, change.removeLabels)
  refuseOverlap("Assignee", change.addAssignees, change.removeAssignees)
  if (changedArguments(change).length === 0) {
    throw invalid(
      "Nothing to change: pass at least one of title, body, append_body, kind, labels, assignees or milestone.",
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
    kind: change.kind !== undefined,
    add_labels: change.addLabels.length > 0,
    remove_labels: change.removeLabels.length > 0,
    add_assignees: change.addAssignees.length > 0,
    remove_assignees: change.removeAssignees.length > 0,
    milestone: change.milestone !== undefined,
    remove_milestone: change.removeMilestone,
  }
  return Object.entries(applied).flatMap(([name, isApplied]) => (isApplied ? [name] : []))
}

/** `current` and `added` apart by a blank line; an empty body takes the text alone. */
function appended(current: string, added: string): string {
  const body = current.trimEnd()
  return body ? `${body}${BODY_SEPARATOR}${added}` : added
}

export const issueEdit = defineTool({
  id: "github_issue_edit",
  title: "Edit a GitHub issue",
  description: [
    "Change an issue in one call: title, body (body replaces it, append_body adds after a blank line), kind (an Issue Type, else a type:<kind> label that replaces the other type: labels), labels and assignees to add or remove (added assignees are notified), milestone or remove_milestone.",
    "A milestone that does not exist is an error unless create_milestone is true. Needs write permission on the repository.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "issues",
  class: "overwrite",
  targets: ISSUE_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    const change = parseChange(args)
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const issue = { repo: target, number: ref.number }

    // Reading the issue also proves it exists, which a milestone that may be created must know first.
    const needsRead = change.appendBody !== undefined || change.kind || (change.milestone && change.createMilestone)
    const current = needsRead ? await readIssueFields(issue, ctx) : undefined
    const body = change.appendBody === undefined ? change.body : appended(current?.body ?? "", change.appendBody)
    const kind = change.kind ? { name: change.kind, placement: await resolveKind(change.kind, target, ctx) } : undefined
    const milestone: MilestoneRef | null = change.milestone
      ? await resolveMilestone(target, change.milestone, { create: change.createMilestone }, ctx)
      : null

    const flags: string[] = []
    if (change.title) flags.push("--title", change.title)
    if (body !== undefined) flags.push("--body-file", "-")
    for (const label of change.addLabels) flags.push("--add-label", label)
    for (const label of change.removeLabels) flags.push("--remove-label", label)
    for (const assignee of change.addAssignees) flags.push("--add-assignee", assignee)
    for (const assignee of change.removeAssignees) flags.push("--remove-assignee", assignee)
    if (milestone) flags.push("--milestone", milestone.title)
    if (change.removeMilestone) flags.push("--remove-milestone")

    // A kind that lands as a label takes the other type: labels off, unless the call itself names them.
    const named = new Set([...change.addLabels, ...change.removeLabels].map((label) => label.toLowerCase()))
    const swapped = (where: KindPlacement): string[] =>
      where.via === "label"
        ? otherKindLabels(current?.labels ?? [], where.name)
            .filter((label) => !named.has(label.toLowerCase()))
            .flatMap((label) => ["--remove-label", label])
        : []
    const attempt = async (where?: KindPlacement) =>
      editIssue(
        target,
        issue.number,
        where ? [...flags, ...(await kindFlags(where, target, ctx)), ...swapped(where)] : flags,
        ctx,
        body,
      )
    const applied = kind
      ? await withKindFallback(kind.name, kind.placement, attempt)
      : { placement: undefined, result: await attempt() }

    return {
      repo: target.full,
      issue: issue.number,
      url: lastUrl(applied.result) ?? `https://github.com/${target.full}/issues/${issue.number}`,
      changed: changedArguments(change),
      kind: applied.placement ?? null,
      milestone,
      foreign: context.foreign,
    }
  },
})
