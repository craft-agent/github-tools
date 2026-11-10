import { z } from "zod"
import { patchRepository, readAdministeredRepository, visibilitySchema, type Visibility } from "../github/repos"
import { REPO_DESCRIPTION, invalid } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"
import { describedRepo, repoHeadline, transitionFact } from "./describe-support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  visibility: visibilitySchema.describe("public, private or internal. internal only for an organization's repository."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  visibility: visibilitySchema,
  previous: visibilitySchema.describe("The visibility it had before."),
})

/** What the change means for who can read the repository, for the confirmation. */
function consequence(from: Visibility, to: Visibility): string {
  if (to === "public") return "Its code, history, issues and wiki become readable by anyone."
  if (from === "public") return "Its stars and watchers are lost, and its forks stay public."
  return to === "internal" ? "Every member of the enterprise can read it." : "Only people given access can read it."
}

/** The headline by the visibility the call asks for. */
const HEADLINES: Readonly<Record<Visibility, string>> = {
  public: "About to make the repository {name} public",
  private: "About to make the repository {name} private",
  internal: "About to make the repository {name} internal",
}

export const repoVisibility = defineTool({
  id: "github_repo_visibility",
  title: "Change a GitHub repository's visibility",
  intent: "About to change a GitHub repository's visibility",
  description:
    "Change a repository's visibility to public, private or internal (internal for an organization's repository only). Making it public lets anyone read its code, history, issues and wiki; making a public one private or internal loses its stars and watchers, and its forks stay public. Needs admin permission; refuses the visibility it has already, before writing.",
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  async describe(args, ctx) {
    const { view } = await describedRepo(args, ctx)
    if (view.visibility === args.visibility) throw invalid(`${view.repo} is ${args.visibility} already.`)
    if (args.visibility === "internal" && view.owner_type !== "organization") {
      throw invalid(`internal is for an organization's repository; ${view.repo} belongs to a user.`)
    }
    return {
      ...repoHeadline(HEADLINES[args.visibility], view.repo),
      facts: [transitionFact(view.visibility, args.visibility)],
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    if (view.visibility === args.visibility) throw invalid(`${view.repo} is ${args.visibility} already.`)
    if (args.visibility === "internal" && view.owner_type !== "organization") {
      throw invalid(`internal is for an organization's repository; ${view.repo} belongs to a user.`)
    }
    await confirmWrite(
      repoVisibility,
      ctx,
      `Make ${view.repo} ${args.visibility}? ${consequence(view.visibility, args.visibility)}`,
    )
    await patchRepository(target, { visibility: args.visibility }, ctx)
    return { repo: view.repo, visibility: args.visibility, previous: view.visibility }
  },
})
