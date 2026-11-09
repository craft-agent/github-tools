import { z } from "zod"
import { patchRepository, readAdministeredRepository } from "../github/repos"
import { REPO_DESCRIPTION, invalid } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"

export const repoArchive = defineTool({
  id: "github_repo_archive",
  title: "Archive a GitHub repository",
  intent: "About to archive a GitHub repository",
  description:
    "Archive a repository, which makes it read-only: no pushes, issues, pull requests or comments until github_repo_unarchive lifts it. Needs admin permission; refuses a repository that is archived already, before writing.",
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  input: z.object({ repo: z.string().optional().describe(REPO_DESCRIPTION) }),
  output: z.object({ repo: z.string().describe("The repository, as owner/name."), archived: z.literal(true) }),
  async execute(args, ctx) {
    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    if (view.archived) throw invalid(`${view.repo} is archived already.`)
    await confirmWrite(
      repoArchive,
      ctx,
      `Archive ${view.repo}? It becomes read-only: no pushes, issues, pull requests or comments until it is unarchived.`,
    )
    await patchRepository(target, { archived: true }, ctx)
    return { repo: view.repo, archived: true as const }
  },
})
