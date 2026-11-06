import { z } from "zod"
import { ToolError } from "../errors"
import { ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"

/** A milestone a call settled on; `created` says whether this call made it. */
export const milestoneSchema = z.object({ number: z.number().int(), title: z.string(), created: z.boolean() })

export type MilestoneRef = z.output<typeof milestoneSchema>

type RawMilestone = { number?: number; title?: string }

function milestonesPath(repo: RepoName): string {
  return `repos/${repo.owner}/${repo.name}/milestones`
}

function isMilestone(value: RawMilestone | null | undefined): value is { number: number; title: string } {
  return typeof value?.number === "number" && typeof value.title === "string"
}

/**
 * The milestone of `repo` titled `title`, matched exactly first and then
 * without regard to case, among open and closed ones. A missing one is made
 * when `create` is set, else `invalid_argument` names what to pass: the
 * `create_milestone` argument, or, for a tool without one (`creatable: false`),
 * creating the milestone first.
 */
export async function resolveMilestone(
  repo: RepoName,
  title: string,
  options: { create: boolean; creatable?: boolean },
  ctx: RefContext,
): Promise<MilestoneRef> {
  // --slurp keeps the pages a valid JSON document: an array of one array per page.
  const pages =
    (await ghJson<RawMilestone[][]>(
      ["api", `${milestonesPath(repo)}?state=all&per_page=100`, "--paginate", "--slurp"],
      ctx,
    )) ?? []
  const milestones = pages.flat().filter(isMilestone)
  const found =
    milestones.find((milestone) => milestone.title === title) ??
    milestones.find((milestone) => milestone.title.toLowerCase() === title.toLowerCase())
  if (found) return { number: found.number, title: found.title, created: false }

  if (!options.create) {
    throw new ToolError(
      "invalid_argument",
      options.creatable === false
        ? `Milestone "${title}" does not exist in ${repo.full}; create it first, or pass an existing title.`
        : `Milestone "${title}" does not exist in ${repo.full}; pass create_milestone: true to create it.`,
    )
  }
  const made = await ghJson<RawMilestone>(["api", "-X", "POST", milestonesPath(repo), "-f", `title=${title}`], ctx)
  if (!isMilestone(made))
    throw new ToolError("github_error", `GitHub did not return the milestone "${title}" it created.`)
  return { number: made.number, title: made.title, created: true }
}
