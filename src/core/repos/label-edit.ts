import { z } from "zod"
import {
  findLabel,
  labelColorInput,
  labelNameInput,
  labelSchema,
  labelsForWrite,
  writeLabel,
  type Label,
  type LabelBody,
} from "../github/labels"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { defineTool, type CallFact } from "../tool"
import { NOTHING_CHANGED } from "../write-facts"
import { describedWritableRepo } from "./describe-support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  name: labelNameInput,
  new_name: labelNameInput.optional().describe("The label's new name."),
  color: labelColorInput.optional(),
  description: z.string().optional().describe("The label's description; empty clears it."),
})
const CHANGES = ["name", "color", "description"] as const

export const labelEdit = defineTool({
  id: "github_label_edit",
  title: "Edit a GitHub label",
  intent: "About to edit a GitHub label",
  description:
    "Edit a repository label, matched without regard to case. Refuses an unknown label, no change arguments, or a new name another label has. Unchanged fields are left alone; changed is [] when nothing is sent.",
  toolset: "repos",
  class: "overwrite",
  targets: { repo: "repo" },
  async describe(args, ctx) {
    if (args.new_name === undefined && args.color === undefined && args.description === undefined) {
      throw invalid("Pass at least one of new_name, color or description to change the label.")
    }
    const repo = await describedWritableRepo(args, ctx)
    const labels = await labelsForWrite(repo, ctx)
    const current = findLabel(labels, args.name)
    if (
      args.new_name !== undefined &&
      labels.some((label) => label !== current && label.name.toLowerCase() === args.new_name!.toLowerCase())
    ) {
      throw invalid(`${repo.full} has another label named "${args.new_name}" already.`)
    }
    const color = args.color?.replace(/^#/, "")
    const renamed = args.new_name !== undefined && args.new_name !== current.name
    const recolored = color !== undefined && color.toLowerCase() !== current.color.toLowerCase()
    const redescribed = args.description !== undefined && args.description !== current.description
    const headline = { text: "About to edit the label {name}", values: { name: current.name } }
    if (!renamed && !recolored && !redescribed) {
      return { headline, facts: [{ label: "State", value: { text: NOTHING_CHANGED } }] }
    }
    const facts: (CallFact | undefined)[] = [
      renamed ? { label: "Name", value: args.new_name! } : undefined,
      recolored ? { label: "Color", value: `#${current.color} \u2192 #${color}` } : undefined,
      redescribed && args.description === "" ? { label: "Description", value: { text: "Cleared" } } : undefined,
    ]
    return {
      headline,
      facts: facts.filter((fact): fact is CallFact => fact !== undefined),
      ...(redescribed && args.description ? { text: { label: "Description", body: args.description } } : {}),
    }
  },
  input,
  output: z.object({ repo: z.string(), label: labelSchema, changed: z.array(z.enum(CHANGES)), foreign: z.boolean() }),
  async execute(args, ctx) {
    if (args.new_name === undefined && args.color === undefined && args.description === undefined) {
      throw invalid("Pass at least one of new_name, color or description to change the label.")
    }
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const labels = await labelsForWrite(repo, ctx)
    const current = findLabel(labels, args.name)
    if (
      args.new_name !== undefined &&
      labels.some((label) => label !== current && label.name.toLowerCase() === args.new_name!.toLowerCase())
    ) {
      throw invalid(`${repo.full} has another label named "${args.new_name}" already.`)
    }
    const proposed: Partial<Label> = {
      name: args.new_name,
      color: args.color?.replace(/^#/, ""),
      description: args.description,
    }
    const changed = CHANGES.filter(
      (field) =>
        proposed[field] !== undefined &&
        (field === "color"
          ? proposed[field]!.toLowerCase() !== current[field].toLowerCase()
          : proposed[field] !== current[field]),
    )
    const body: LabelBody = {}
    for (const field of changed) body[field === "name" ? "new_name" : field] = proposed[field]
    const label = changed.length === 0 ? current : (await writeLabel(repo, "PATCH", body, ctx, current.name)).label
    return { repo: repo.full, label, changed, foreign: context.foreign }
  },
})
