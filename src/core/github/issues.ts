import { z } from "zod"
import { ToolError, isToolError, type ErrorCode } from "../errors"
import { graphql, paginate, type Vars } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { readKind } from "./kind"

/** Issue reads shared by the issue tools: one issue in full, a search over a repository and a parent's sub-issues. */

const PREVIEW_ASSIGNEES = 20
const PREVIEW_LABELS = 30
const ROW_ASSIGNEES = 10
const ROW_LABELS = 20
const MAX_SUB_ISSUES = 100
const MAX_DEPENDENCIES = 50
const MAX_LINKED = 20
const MAX_SEARCH_PAGE = 100
const MAX_LABELS = 100

export const issueBriefSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  repo: z.string(),
})

export const subIssueProgressSchema = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  percent: z.number(),
})

export const issueDetailSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  state_reason: z.string().nullable(),
  body: z.string(),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  milestone: z.object({ number: z.number().int(), title: z.string(), due_on: z.string().nullable() }).nullable(),
  kind: z.string().nullable(),
  issue_type: z.string().nullable(),
  parent: issueBriefSchema.nullable(),
  sub_issues: z.array(issueBriefSchema),
  sub_issue_progress: subIssueProgressSchema,
  blocked_by: z.array(issueBriefSchema),
  blocking: z.array(issueBriefSchema),
  dependencies_error: z.string().nullable(),
  linked_branches: z.array(z.string()),
  closing_pull_requests: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      merged: z.boolean(),
    }),
  ),
  projects: z.array(
    z.object({
      item_id: z.string(),
      archived: z.boolean(),
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
    }),
  ),
  comments: z.array(
    z.object({ author: z.string().nullable(), created_at: z.string(), body: z.string(), url: z.string() }),
  ),
  comment_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const issueRowSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  kind: z.string().nullable(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  milestone: z.string().nullable(),
  parent: issueBriefSchema.nullable(),
  sub_issue_progress: subIssueProgressSchema.nullable(),
  updated_at: z.string(),
})

export type IssueBrief = z.output<typeof issueBriefSchema>
export type IssueDetail = z.output<typeof issueDetailSchema>
export type IssueRow = z.output<typeof issueRowSchema>
export type SubIssueProgress = z.output<typeof subIssueProgressSchema>

type Connection<T> = { nodes?: (T | null)[] | null } | null | undefined

type RawBrief = {
  number: number
  title: string
  url: string
  state: string
  repository?: { nameWithOwner?: string } | null
}

type RawSummary = { total: number; completed: number; percentCompleted: number }

type RawRow = RawBrief & {
  updatedAt: string
  issueType?: { name?: string } | null
  labels?: Connection<{ name: string }>
  assignees?: Connection<{ login: string }>
  milestone?: { title: string } | null
  parent?: RawBrief | null
  subIssuesSummary?: RawSummary | null
}

type RawIssue = RawBrief & {
  id: string
  stateReason?: string | null
  body?: string | null
  createdAt: string
  updatedAt: string
  author?: { login: string } | null
  assignees?: Connection<{ login: string }>
  labels?: Connection<{ name: string }>
  milestone?: { number: number; title: string; dueOn?: string | null } | null
  issueType?: { name?: string } | null
  parent?: RawBrief | null
  subIssues?: Connection<RawBrief>
  subIssuesSummary?: RawSummary | null
  linkedBranches?: Connection<{ ref?: { name?: string } | null }>
  closedByPullRequestsReferences?: Connection<{
    number: number
    title: string
    url: string
    state: string
    merged?: boolean
  }>
  projectItems?: Connection<{
    id: string
    isArchived?: boolean
    project: { number: number; title: string; url: string }
  }>
  comments?: {
    totalCount?: number
    nodes?:
      ({ author?: { login: string } | null; createdAt: string; body?: string | null; url: string } | null)[] | null
  } | null
}

const BRIEF_FIELDS = "number title url state repository{nameWithOwner}"
const SUMMARY_FIELDS = "subIssuesSummary{total completed percentCompleted}"
const ROW_FIELDS = `${BRIEF_FIELDS} updatedAt issueType{name} labels(first:${ROW_LABELS}){nodes{name}} assignees(first:${ROW_ASSIGNEES}){nodes{login}} milestone{title} parent{${BRIEF_FIELDS}} ${SUMMARY_FIELDS}`

const DETAIL_QUERY = `query($owner:String!,$name:String!,$n:Int!,$comments:Int!,$withComments:Boolean!){repository(owner:$owner,name:$name){issue(number:$n){
  id ${BRIEF_FIELDS} stateReason body createdAt updatedAt author{login}
  assignees(first:${PREVIEW_ASSIGNEES}){nodes{login}} labels(first:${PREVIEW_LABELS}){nodes{name}}
  milestone{number title dueOn} issueType{name}
  parent{${BRIEF_FIELDS}}
  subIssues(first:${MAX_SUB_ISSUES}){nodes{${BRIEF_FIELDS}}} ${SUMMARY_FIELDS}
  linkedBranches(first:${MAX_LINKED}){nodes{ref{name}}}
  closedByPullRequestsReferences(first:${MAX_LINKED},includeClosedPrs:true){nodes{number title url state merged}}
  projectItems(first:${MAX_LINKED}){nodes{id isArchived project{number title url}}}
  comments(last:$comments){totalCount nodes @include(if:$withComments){author{login} createdAt body url}}
}}}`

const DEPENDENCIES_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){blockedBy(first:${MAX_DEPENDENCIES}){nodes{${BRIEF_FIELDS}}} blocking(first:${MAX_DEPENDENCIES}){nodes{${BRIEF_FIELDS}}}}}}`

const SUB_ISSUES_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
  ${BRIEF_FIELDS}
  subIssues(first:${MAX_SUB_ISSUES}){pageInfo{hasNextPage} nodes{${ROW_FIELDS}}}
}}}`

const FIELDS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
  state stateReason body labels(first:${MAX_LABELS}){nodes{name}}
}}}`

/**
 * `type:ISSUE`, not `ISSUE_ADVANCED`: the plain search applies every
 * qualifier to the whole query, so `repo:a/b x OR y` stays in `a/b`, while the
 * advanced search reads it as `(repo:a/b x) OR y` and leaves the repository.
 * The issue tools rely on this to keep a caller's words inside one repository.
 */
const SEARCH_QUERY = `query($q:String!,$first:Int!,$after:String){search(type:ISSUE,query:$q,first:$first,after:$after){pageInfo{hasNextPage endCursor} nodes{... on Issue{${ROW_FIELDS}}}}}`

function nodesOf<T>(connection: Connection<T>): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node != null)
}

function brief(node: RawBrief): IssueBrief {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    repo: node.repository?.nameWithOwner ?? "",
  }
}

function progress(summary: RawSummary): SubIssueProgress {
  return { total: summary.total, completed: summary.completed, percent: summary.percentCompleted }
}

function row(node: RawRow): IssueRow {
  const labels = nodesOf(node.labels).map((label) => label.name)
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    kind: readKind(node.issueType?.name, labels),
    labels,
    assignees: nodesOf(node.assignees).map((assignee) => assignee.login),
    milestone: node.milestone?.title ?? null,
    parent: node.parent ? brief(node.parent) : null,
    sub_issue_progress: node.subIssuesSummary ? progress(node.subIssuesSummary) : null,
    updated_at: node.updatedAt,
  }
}

function issueNotFound(repo: RepoName, number: number, cause?: unknown): ToolError {
  return new ToolError(
    "not_found",
    `Issue ${repo.full}#${number} was not found: it does not exist, is a pull request, or the viewer cannot see it.`,
    { cause },
  )
}

/** Runs a read of one issue, turning GitHub's "could not resolve" into this issue's `not_found`. */
async function readIssueData<T>(
  query: string,
  ref: { repo: RepoName; number: number },
  vars: Vars,
  ctx: RefContext,
): Promise<T> {
  let data: { repository?: { issue?: T | null } | null } | null
  try {
    data = await graphql(query, { owner: ref.repo.owner, name: ref.repo.name, n: ref.number, ...vars }, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw issueNotFound(ref.repo, ref.number, error)
    throw error
  }
  const issue = data?.repository?.issue
  if (!issue) throw issueNotFound(ref.repo, ref.number)
  return issue
}

/**
 * The failures of the dependencies read that leave the issue readable: a
 * GitHub without the fields, or a repository where they are not allowed. Any
 * other failure (auth, rate limit, a missing `gh`, the issue gone) is the
 * call's failure, not an empty list.
 */
const DEPENDENCIES_SOFT_CODES: readonly ErrorCode[] = ["github_error", "forbidden"]

/**
 * One issue in full, from one read, plus its dependencies from a second that
 * fails soft on `DEPENDENCIES_SOFT_CODES`: the picture stays usable without
 * them, and `dependencies_error` says why they are empty. `comments` is how many of the latest comments to
 * include (0 for none); the count of all of them is always reported.
 */
export async function readIssue(
  ref: { repo: RepoName; number: number },
  options: { comments: number },
  ctx: RefContext,
): Promise<IssueDetail> {
  const issue = await readIssueData<RawIssue>(
    DETAIL_QUERY,
    ref,
    { comments: Math.max(options.comments, 1), withComments: options.comments > 0 },
    ctx,
  )

  let dependencies: { blocked_by: IssueBrief[]; blocking: IssueBrief[] } | undefined
  let dependenciesError: string | null = null
  try {
    const reply = await readIssueData<{
      blockedBy?: Connection<RawBrief>
      blocking?: Connection<RawBrief>
    }>(DEPENDENCIES_QUERY, ref, {}, ctx)
    dependencies = { blocked_by: nodesOf(reply.blockedBy).map(brief), blocking: nodesOf(reply.blocking).map(brief) }
  } catch (error) {
    if (!isToolError(error) || !DEPENDENCIES_SOFT_CODES.includes(error.code)) throw error
    dependenciesError = `${error.code}: ${error.message}`
  }

  const labels = nodesOf(issue.labels).map((label) => label.name)
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    body: issue.body ?? "",
    author: issue.author?.login ?? null,
    assignees: nodesOf(issue.assignees).map((assignee) => assignee.login),
    labels,
    milestone: issue.milestone
      ? { number: issue.milestone.number, title: issue.milestone.title, due_on: issue.milestone.dueOn ?? null }
      : null,
    kind: readKind(issue.issueType?.name, labels),
    issue_type: issue.issueType?.name ?? null,
    parent: issue.parent ? brief(issue.parent) : null,
    sub_issues: nodesOf(issue.subIssues).map(brief),
    sub_issue_progress: issue.subIssuesSummary
      ? progress(issue.subIssuesSummary)
      : { total: 0, completed: 0, percent: 0 },
    blocked_by: dependencies?.blocked_by ?? [],
    blocking: dependencies?.blocking ?? [],
    dependencies_error: dependenciesError,
    linked_branches: nodesOf(issue.linkedBranches).flatMap((branch) => (branch.ref?.name ? [branch.ref.name] : [])),
    closing_pull_requests: nodesOf(issue.closedByPullRequestsReferences).map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: pull.state,
      merged: Boolean(pull.merged),
    })),
    projects: nodesOf(issue.projectItems).map((item) => ({
      item_id: item.id,
      archived: Boolean(item.isArchived),
      number: item.project.number,
      title: item.project.title,
      url: item.project.url,
    })),
    comments: nodesOf(issue.comments).map((comment) => ({
      author: comment.author?.login ?? null,
      created_at: comment.createdAt,
      body: comment.body ?? "",
      url: comment.url,
    })),
    comment_count: issue.comments?.totalCount ?? 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  }
}

/**
 * Issues matching a GitHub search query, at most `limit`, with `truncated` set
 * when more matched. The query is sent as it is; the caller builds and checks it.
 */
export async function searchIssues(
  query: string,
  limit: number,
  ctx: RefContext,
): Promise<{ issues: IssueRow[]; truncated: boolean }> {
  const { items, truncated } = await paginate<RawRow | Record<string, never> | null>(
    SEARCH_QUERY,
    { q: query, first: Math.min(limit, MAX_SEARCH_PAGE) },
    (data: { search?: { nodes: (RawRow | Record<string, never> | null)[] } | null } | null) => data?.search,
    { cwd: ctx.cwd, signal: ctx.signal, limit },
  )
  // A search hit that is not an issue comes back as an empty object.
  const issues = items.filter((node): node is RawRow => node != null && "number" in node).map(row)
  return { issues, truncated }
}

/** What a write needs to know about an issue before it changes it: its state, body and labels. */
export type IssueFields = { state: string; state_reason: string | null; body: string; labels: string[] }

/** The state, body and labels of one issue, in one small read. */
export async function readIssueFields(ref: { repo: RepoName; number: number }, ctx: RefContext): Promise<IssueFields> {
  const issue = await readIssueData<Pick<RawIssue, "state" | "stateReason" | "body" | "labels">>(
    FIELDS_QUERY,
    ref,
    {},
    ctx,
  )
  return {
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    body: issue.body ?? "",
    labels: nodesOf(issue.labels).map((label) => label.name),
  }
}

/**
 * The sub-issues of `parent` in GitHub's order, as list rows, with the parent
 * itself and `more` set when GitHub holds sub-issues beyond the page read (an
 * issue has at most 100, which is the page size).
 */
export async function readSubIssues(
  parent: { repo: RepoName; number: number },
  ctx: RefContext,
): Promise<{ parent: IssueBrief; issues: IssueRow[]; more: boolean }> {
  const issue = await readIssueData<
    RawBrief & { subIssues?: Connection<RawRow> & { pageInfo?: { hasNextPage?: boolean } } }
  >(SUB_ISSUES_QUERY, parent, {}, ctx)
  return {
    parent: brief(issue),
    issues: nodesOf(issue.subIssues).map(row),
    more: Boolean(issue.subIssues?.pageInfo?.hasNextPage),
  }
}
