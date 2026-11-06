import { z } from "zod"
import { ToolError } from "../errors"
import { ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { readRepositoryPages } from "./repos"

/** A milestone a call settled on; `created` says whether this call made it. */
export const milestoneSchema = z.object({ number: z.number().int(), title: z.string(), created: z.boolean() })

export type MilestoneRef = z.output<typeof milestoneSchema>

/** The most milestones read in one list; a repository with more is reported as truncated. */
const MAX_MILESTONES_READ = 1000
const DATE_LENGTH = "YYYY-MM-DD".length

export const MILESTONE_STATES = ["open", "closed", "all"] as const

export type MilestoneState = (typeof MILESTONE_STATES)[number]

const GRAPHQL_STATES: Record<MilestoneState, string> = {
  open: "OPEN",
  closed: "CLOSED",
  all: "OPEN,CLOSED",
}

/** A milestone as a list reports it. */
export const milestoneRowSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  due: z.string().nullable().describe("The due date as YYYY-MM-DD; null when there is none."),
  description: z.string().describe("Empty when there is none."),
  progress: z.number().nullable().describe("Percent of its issues and pull requests that are closed (0-100)."),
  open_issues: z.number().int(),
  closed_issues: z.number().int(),
  url: z.string(),
})

export type MilestoneRow = z.output<typeof milestoneRowSchema>

type RawMilestoneRow = {
  number: number
  title: string
  state: string
  dueOn?: string | null
  description?: string | null
  progressPercentage?: number | null
  openIssueCount: number
  closedIssueCount: number
  url: string
}

function milestonesQuery(state: MilestoneState): string {
  return `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    milestones(first:100,after:$after,states:[${GRAPHQL_STATES[state]}],orderBy:{field:DUE_DATE,direction:ASC}){
      nodes{number title state dueOn description progressPercentage openIssueCount closedIssueCount url}
      pageInfo{hasNextPage endCursor}
    }
  }
}`
}

function toRow(raw: RawMilestoneRow): MilestoneRow {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state.toUpperCase() === "CLOSED" ? "closed" : "open",
    due: raw.dueOn?.slice(0, DATE_LENGTH) ?? null,
    description: raw.description ?? "",
    progress: raw.progressPercentage ?? null,
    open_issues: raw.openIssueCount,
    closed_issues: raw.closedIssueCount,
    url: raw.url,
  }
}

/**
 * The repository's milestones in `state`, by due date ascending with those
 * that have none last (GitHub puts them first), at most `limit`. `truncated`
 * says more matched, or that the repository holds more than are read.
 */
export async function listMilestones(
  repo: RepoName,
  options: { state: MilestoneState; limit: number },
  ctx: RefContext,
): Promise<{ milestones: MilestoneRow[]; truncated: boolean }> {
  const { items, truncated } = await readRepositoryPages<RawMilestoneRow>(
    repo,
    milestonesQuery(options.state),
    (repository) => repository.milestones,
    { ...ctx, limit: MAX_MILESTONES_READ },
  )
  const rows = items.map(toRow)
  const ordered = [...rows.filter((row) => row.due !== null), ...rows.filter((row) => row.due === null)]
  return {
    milestones: ordered.slice(0, options.limit),
    truncated: truncated || ordered.length > options.limit,
  }
}

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
