import { z } from "zod"
import {
  milestoneDue,
  milestoneDueInput,
  milestoneTitleInput,
  milestoneWriteSchema,
  milestonesForWrite,
  writeMilestone,
} from "../github/milestones"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { defineTool } from "../tool"
import { describedWritableRepo } from "./describe-support"

export const milestoneCreate = defineTool({
  id: "github_milestone_create",
  title: "Create a GitHub milestone",
  intent: "About to create a GitHub milestone",
  description:
    "Create a repository milestone with an optional due date and description. Refuses a title the repository has in any state, without regard to case; use github_milestone_edit to change it. due must be a real YYYY-MM-DD date.",
  toolset: "repos",
  class: "add",
  targets: { repo: "repo" },
  async describe(args, ctx) {
    const repo = await describedWritableRepo(args, ctx)
    const milestones = await milestonesForWrite(repo, ctx)
    const existing = milestones.find((row) => row.title.toLowerCase() === args.title.toLowerCase())
    if (existing)
      throw invalid(`${repo.full} has the milestone "${existing.title}" already; change it with github_milestone_edit.`)
    return {
      headline: { text: "About to create the milestone {title}", values: { title: args.title } },
      facts: args.due === undefined ? [] : [{ label: "Due date", value: args.due }],
      ...(args.description ? { text: { label: "Description", body: args.description } } : {}),
    }
  },
  input: z.object({
    repo: z.string().optional().describe(REPO_DESCRIPTION),
    title: milestoneTitleInput.describe("The milestone's title."),
    due: milestoneDueInput.optional(),
    description: z.string().optional().describe("The milestone's description."),
  }),
  output: z.object({ repo: z.string(), milestone: milestoneWriteSchema, foreign: z.boolean() }),
  async execute(args, ctx) {
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const milestones = await milestonesForWrite(repo, ctx)
    const existing = milestones.find((row) => row.title.toLowerCase() === args.title.toLowerCase())
    if (existing)
      throw invalid(`${repo.full} has the milestone "${existing.title}" already; change it with github_milestone_edit.`)
    const milestone = await writeMilestone(
      repo,
      {
        title: args.title,
        ...(args.due === undefined ? {} : { due_on: milestoneDue(args.due) }),
        ...(args.description === undefined ? {} : { description: args.description }),
      },
      ctx,
    )
    return { repo: repo.full, milestone, foreign: context.foreign }
  },
})
