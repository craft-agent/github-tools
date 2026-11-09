import { z } from "zod"
import { deleteLabel, findLabel, labelNameInput, labelsForWrite } from "../github/labels"
import { REPO_DESCRIPTION, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"

export const labelDelete = defineTool({
  id: "github_label_delete",
  title: "Delete a GitHub label",
  intent: "About to delete a GitHub label",
  description:
    "Delete a repository label, matched without regard to case, removing it from every issue and pull request it is on. Refuses an unknown label before writing.",
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  input: z.object({ repo: z.string().optional().describe(REPO_DESCRIPTION), name: labelNameInput }),
  output: z.object({ repo: z.string(), deleted: z.string(), foreign: z.boolean() }),
  async execute(args, ctx) {
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const label = findLabel(await labelsForWrite(repo, ctx), args.name)
    await confirmWrite(
      labelDelete,
      ctx,
      `Delete the label "${label.name}" from ${repo.full}? It leaves every issue and pull request it is on.`,
    )
    await deleteLabel(repo, label.name, ctx)
    return { repo: repo.full, deleted: label.name, foreign: context.foreign }
  },
})
