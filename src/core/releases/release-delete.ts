import { z } from "zod"
import { deleteRelease, findRelease, releaseNotFound, releaseTagInput, tagCommit } from "../github/releases"
import { REPO_DESCRIPTION, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  tag: releaseTagInput,
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  deleted: z.string().describe("The git tag name of the deleted release."),
  tag_kept: z.boolean().describe("Whether the git tag exists on GitHub."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
})

export const releaseDelete = defineTool({
  id: "github_release_delete",
  title: "Delete a GitHub release",
  description:
    "Delete a GitHub release and its assets, keeping its git tag. Refuses an unknown release. Cannot be undone.",
  toolset: "releases",
  class: "administrative",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const current = await findRelease(repo, args.tag, ctx)
    if (!current) {
      throw releaseNotFound(repo, args.tag)
    }

    const tagSha = await tagCommit(repo, current.tag_name, ctx)
    const tag_kept = tagSha !== null

    await confirmWrite(
      releaseDelete,
      ctx,
      `Delete the ${current.draft ? "draft" : "published"} release ${args.tag} from ${repo.full}? Its tag stays; the release and its assets cannot be brought back.`,
    )

    await deleteRelease(repo, current.id, ctx)

    return {
      repo: repo.full,
      deleted: current.tag_name,
      tag_kept,
      foreign: context.foreign,
    }
  },
})
