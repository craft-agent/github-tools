import { z } from "zod"
import { patchRepository, readAdministeredRepository } from "../github/repos"
import { REPO_DESCRIPTION } from "../write-support"
import { resolveRepo } from "../refs"
import { defineTool } from "../tool"

export const repoUnarchive = defineTool({
  id: "github_repo_unarchive",
  title: "Unarchive a GitHub repository",
  intent: "About to unarchive a GitHub repository",
  description:
    "Unarchive a repository, which makes it writable again. Needs admin permission. A repository that is not archived is left as it is: changed is false and nothing is sent.",
  toolset: "repos",
  class: "overwrite",
  targets: { repo: "repo" },
  input: z.object({ repo: z.string().optional().describe(REPO_DESCRIPTION) }),
  output: z.object({
    repo: z.string().describe("The repository, as owner/name."),
    archived: z.literal(false),
    changed: z.boolean().describe("False when the repository was not archived and nothing was sent."),
  }),
  async execute(args, ctx) {
    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    if (view.archived) await patchRepository(target, { archived: false }, ctx)
    return { repo: view.repo, archived: false as const, changed: view.archived }
  },
})
