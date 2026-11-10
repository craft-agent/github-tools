import { z } from "zod"
import { labelColorInput, labelNameInput, labelSchema, labelsForWrite, writeLabel } from "../github/labels"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { defineTool } from "../tool"
import { describedWritableRepo } from "./describe-support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  name: labelNameInput,
  color: labelColorInput.optional(),
  description: z.string().optional().describe("The label's description."),
})

export const labelCreate = defineTool({
  id: "github_label_create",
  title: "Create a GitHub label",
  intent: "About to create a GitHub label",
  description:
    "Create a repository label. Refuses a name the repository has already, without regard to case; use github_label_edit to change it. Without color, GitHub picks one.",
  toolset: "repos",
  class: "add",
  targets: { repo: "repo" },
  async describe(args, ctx) {
    const repo = await describedWritableRepo(args, ctx)
    const labels = await labelsForWrite(repo, ctx)
    const existing = labels.find((label) => label.name.toLowerCase() === args.name.toLowerCase())
    if (existing)
      throw invalid(`${repo.full} has the label "${existing.name}" already; change it with github_label_edit.`)
    return {
      headline: { text: "About to create the label {name}", values: { name: args.name } },
      facts: args.color === undefined ? [] : [{ label: "Color", value: `#${args.color.replace(/^#/, "")}` }],
      ...(args.description ? { text: { label: "Description", body: args.description } } : {}),
    }
  },
  input,
  output: z.object({ repo: z.string(), label: labelSchema, foreign: z.boolean() }),
  async execute(args, ctx) {
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const labels = await labelsForWrite(repo, ctx)
    const existing = labels.find((label) => label.name.toLowerCase() === args.name.toLowerCase())
    if (existing)
      throw invalid(`${repo.full} has the label "${existing.name}" already; change it with github_label_edit.`)
    const made = await writeLabel(
      repo,
      "POST",
      {
        name: args.name,
        ...(args.color === undefined ? {} : { color: args.color.replace(/^#/, "") }),
        ...(args.description === undefined ? {} : { description: args.description }),
      },
      ctx,
    )
    return { repo: repo.full, ...made, foreign: context.foreign }
  },
})
