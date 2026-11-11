import { z } from "zod"
import {
  findMilestone,
  milestoneDue,
  milestoneDueInput,
  milestoneTitleInput,
  milestoneWriteSchema,
  milestonesForWrite,
  writeMilestone,
  type MilestoneBody,
} from "../github/milestones"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { githubTargets } from "../github/targets"
import { defineTool, type CallFact } from "../tool"
import { NOTHING_CHANGED, stateFact } from "../write-facts"
import { describedWritableRepo } from "./describe-support"

const CHANGES = ["title", "due", "description", "state"] as const

export const milestoneEdit = defineTool({
  id: "github_milestone_edit",
  title: "Edit a GitHub milestone",
  intent: "About to edit a GitHub milestone",
  description:
    "Edit a repository milestone by number or title (any case, any state). Refuses an unknown milestone, no change arguments, due with clear_due, or a title another milestone has. due must be a real YYYY-MM-DD date. Unchanged fields are left alone; changed is [] when nothing is sent.",
  toolset: "repos",
  class: "overwrite",
  targets: githubTargets({ repo: "repo" }),
  async describe(args, ctx) {
    if (args.due !== undefined && args.clear_due !== undefined) throw invalid("Pass due or clear_due, not both.")
    if (
      args.title === undefined &&
      args.due === undefined &&
      !args.clear_due &&
      args.description === undefined &&
      args.state === undefined
    ) {
      throw invalid("Pass at least one of title, due, clear_due, description or state to change the milestone.")
    }
    const repo = await describedWritableRepo(args, ctx)
    const milestones = await milestonesForWrite(repo, ctx)
    const current = await findMilestone(repo, milestones, args.milestone, ctx)
    if (
      args.title !== undefined &&
      milestones.some((row) => row.number !== current.number && row.title.toLowerCase() === args.title!.toLowerCase())
    ) {
      throw invalid(`${repo.full} has another milestone titled "${args.title}" already.`)
    }
    const proposed = {
      title: args.title,
      due: args.clear_due ? null : args.due,
      description: args.description,
      state: args.state,
    }
    const changed = CHANGES.filter((field) => proposed[field] !== undefined && proposed[field] !== current[field])
    const headline = { text: "About to edit the milestone {title}", values: { title: current.title } }
    if (changed.length === 0) return { headline, facts: [{ label: "State", value: { text: NOTHING_CHANGED } }] }

    const description = changed.includes("description") ? args.description : undefined
    const facts: (CallFact | undefined)[] = [
      changed.includes("title") ? { label: "Title", value: args.title! } : undefined,
      changed.includes("state") ? stateFact(args.state!) : undefined,
      changed.includes("due")
        ? {
            label: "Due date",
            value:
              proposed.due === null
                ? { text: "Cleared" }
                : current.due === null
                  ? proposed.due!
                  : `${current.due} \u2192 ${proposed.due}`,
          }
        : undefined,
      description === "" ? { label: "Description", value: { text: "Cleared" } } : undefined,
    ]
    return {
      headline,
      facts: facts.filter((fact): fact is CallFact => fact !== undefined),
      ...(description ? { text: { label: "Description", body: description } } : {}),
    }
  },
  input: z.object({
    repo: z.string().optional().describe(REPO_DESCRIPTION),
    milestone: z
      .union([z.number().int().positive(), z.string().trim().min(1)])
      .describe("The milestone's number or title, without regard to case, in any state."),
    title: milestoneTitleInput.optional().describe("The milestone's new title."),
    due: milestoneDueInput.optional(),
    clear_due: z.boolean().optional().describe("Remove the due date; cannot be given with due."),
    description: z.string().optional().describe("The milestone's description; empty clears it."),
    state: milestoneWriteSchema.shape.state.optional().describe("Open or close the milestone."),
  }),
  output: z.object({
    repo: z.string(),
    milestone: milestoneWriteSchema,
    changed: z.array(z.enum(CHANGES)),
    foreign: z.boolean(),
  }),
  async execute(args, ctx) {
    if (args.due !== undefined && args.clear_due !== undefined) throw invalid("Pass due or clear_due, not both.")
    if (
      args.title === undefined &&
      args.due === undefined &&
      !args.clear_due &&
      args.description === undefined &&
      args.state === undefined
    ) {
      throw invalid("Pass at least one of title, due, clear_due, description or state to change the milestone.")
    }
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const milestones = await milestonesForWrite(repo, ctx)
    const current = await findMilestone(repo, milestones, args.milestone, ctx)
    if (
      args.title !== undefined &&
      milestones.some((row) => row.number !== current.number && row.title.toLowerCase() === args.title!.toLowerCase())
    ) {
      throw invalid(`${repo.full} has another milestone titled "${args.title}" already.`)
    }
    const proposed = {
      title: args.title,
      due: args.clear_due ? null : args.due,
      description: args.description,
      state: args.state,
    }
    const changed = CHANGES.filter((field) => proposed[field] !== undefined && proposed[field] !== current[field])
    const body: MilestoneBody = {}
    for (const field of changed) {
      if (field === "due") body.due_on = proposed.due === null ? null : milestoneDue(proposed.due!)
      else if (field === "state") body.state = proposed.state
      else body[field] = proposed[field]
    }
    const milestone = changed.length === 0 ? current : await writeMilestone(repo, body, ctx, current.number)
    return { repo: repo.full, milestone, changed, foreign: context.foreign }
  },
})
