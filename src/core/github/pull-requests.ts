import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { graphql, paginate } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { checksSummarySchema, summarizeChecks, type CheckContexts } from "./checks"
import { stateWord } from "./issues"

const PREVIEW_LABELS = 30
const PREVIEW_ASSIGNEES = 20
const ROW_LABELS = 20
const ROW_ASSIGNEES = 10
const MAX_LINKED = 20
const MAX_THREADS = 100
const MAX_CONTEXTS = 100
const MAX_SEARCH_PAGE = 100
const STATE_DESCRIPTION = "open, closed or merged."

export const pullRequestRowSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string().describe(STATE_DESCRIPTION),
  draft: z.boolean(),
  author: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  review_decision: z.string().nullable(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  milestone: z.string().nullable(),
  updated_at: z.string(),
})

export const pullRequestDetailSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string().describe(STATE_DESCRIPTION),
  draft: z.boolean(),
  body: z.string(),
  author: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  head_sha: z.string(),
  head_repo: z.string().nullable(),
  cross_repository: z.boolean(),
  mergeable: z.string().describe("mergeable, conflicting or unknown."),
  merge_state: z.string(),
  review_decision: z.string().nullable(),
  size: z.object({
    additions: z.number().int(),
    deletions: z.number().int(),
    changed_files: z.number().int(),
    commits: z.number().int(),
  }),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  milestone: z.object({ number: z.number().int(), title: z.string(), due_on: z.string().nullable() }).nullable(),
  review_requests: z.array(z.string()),
  reviews: z.array(z.object({ author: z.string().nullable(), state: z.string(), submitted_at: z.string().nullable() })),
  unresolved_threads: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().nullable(),
      outdated: z.boolean(),
      author: z.string().nullable(),
      body: z.string(),
      url: z.string().nullable(),
    }),
  ),
  unresolved_threads_truncated: z.boolean(),
  closing_issues: z.array(
    z.object({ number: z.number().int(), title: z.string(), url: z.string(), state: z.string(), repo: z.string() }),
  ),
  auto_merge: z.object({ method: z.string(), enabled_by: z.string().nullable() }).nullable(),
  checks: checksSummarySchema,
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
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
})

export type PullRequestDetail = z.output<typeof pullRequestDetailSchema>
export type PullRequestRow = z.output<typeof pullRequestRowSchema>

type Connection<T> = { nodes?: (T | null)[] | null } | null | undefined
type Author = { login: string }
type RawRow = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author?: Author | null
  baseRefName: string
  headRefName: string
  reviewDecision?: string | null
  labels?: Connection<{ name: string }>
  assignees?: Connection<Author>
  milestone?: { title: string } | null
  updatedAt: string
}
type RawThread = {
  isResolved: boolean
  isOutdated: boolean
  path: string
  line?: number | null
  comments?: Connection<{ author?: Author | null; body?: string | null; url?: string | null }>
}
type RawPullRequest = Omit<RawRow, "milestone"> & {
  id: string
  body?: string | null
  createdAt: string
  mergedAt?: string | null
  closedAt?: string | null
  headRefOid: string
  headRepository?: { nameWithOwner: string } | null
  isCrossRepository: boolean
  mergeable: string
  mergeStateStatus: string
  additions: number
  deletions: number
  changedFiles: number
  commits: { totalCount: number }
  milestone?: { number: number; title: string; dueOn?: string | null } | null
  reviewRequests?: Connection<{
    requestedReviewer?: { __typename: string; login?: string; combinedSlug?: string } | null
  }>
  latestReviews?: Connection<{ author?: Author | null; state: string; submittedAt?: string | null }>
  reviewThreads?: Connection<RawThread> & { totalCount: number }
  closingIssuesReferences?: Connection<{
    number: number
    title: string
    url: string
    state: string
    repository: { nameWithOwner: string }
  }>
  autoMergeRequest?: { mergeMethod: string; enabledBy?: Author | null } | null
  projectItems?: Connection<{
    id: string
    isArchived?: boolean
    project: { number: number; title: string; url: string }
  }>
  lastCommit?: Connection<{
    commit?: { statusCheckRollup?: { state: string; contexts?: CheckContexts | null } | null } | null
  }>
  comments?: Connection<{ author?: Author | null; createdAt: string; body?: string | null; url: string }> & {
    totalCount: number
  }
}

const ROW_FIELDS = `number title url state isDraft author{login} baseRefName headRefName reviewDecision labels(first:${ROW_LABELS}){nodes{name}} assignees(first:${ROW_ASSIGNEES}){nodes{login}} milestone{title} updatedAt`
const DETAIL_QUERY = `query($owner:String!,$name:String!,$n:Int!,$comments:Int!,$withComments:Boolean!){repository(owner:$owner,name:$name){pullRequest(number:$n){
  id number title url state isDraft body author{login} createdAt updatedAt mergedAt closedAt
  baseRefName headRefName headRefOid headRepository{nameWithOwner} isCrossRepository
  mergeable mergeStateStatus reviewDecision additions deletions changedFiles commits{totalCount}
  labels(first:${PREVIEW_LABELS}){nodes{name}} assignees(first:${PREVIEW_ASSIGNEES}){nodes{login}} milestone{number title dueOn}
  reviewRequests(first:${MAX_LINKED}){nodes{requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}}}
  latestReviews(first:${MAX_LINKED}){nodes{author{login} state submittedAt}}
  reviewThreads(first:${MAX_THREADS}){totalCount nodes{isResolved isOutdated path line comments(first:1){nodes{author{login} body url}}}}
  closingIssuesReferences(first:${MAX_LINKED}){nodes{number title url state repository{nameWithOwner}}}
  autoMergeRequest{mergeMethod enabledBy{login}}
  projectItems(first:${MAX_LINKED}){nodes{id isArchived project{number title url}}}
  lastCommit: commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:${MAX_CONTEXTS}){totalCount pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$n) detailsUrl} ... on StatusContext{context state isRequired(pullRequestNumber:$n) targetUrl}}}}}}}
  comments(last:$comments){totalCount nodes @include(if:$withComments){author{login} createdAt body url}}
}}}`

/** Plain ISSUE search keeps every qualifier, including the repository, scoped across OR expressions. */
const SEARCH_QUERY = `query($q:String!,$first:Int!,$after:String){search(type:ISSUE,query:$q,first:$first,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${ROW_FIELDS}}}}}`

function nodesOf<T>(connection: Connection<T>): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node != null)
}

function row(node: RawRow): PullRequestRow {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: stateWord(node.state),
    draft: node.isDraft,
    author: node.author?.login ?? null,
    base: node.baseRefName,
    head: node.headRefName,
    review_decision: stateWord(node.reviewDecision),
    labels: nodesOf(node.labels).map((label) => label.name),
    assignees: nodesOf(node.assignees).map((assignee) => assignee.login),
    milestone: node.milestone?.title ?? null,
    updated_at: node.updatedAt,
  }
}

function pullRequestNotFound(repo: RepoName, number: number, cause?: unknown): ToolError {
  return new ToolError(
    "not_found",
    `Pull request ${repo.full}#${number} was not found: it does not exist, is an issue, or the viewer cannot see it.`,
    { cause },
  )
}

/** One pull request in full, from one read; the comment count is reported even when no comments are requested. */
export async function readPullRequest(
  ref: { repo: RepoName; number: number },
  options: { comments: number },
  ctx: RefContext,
): Promise<PullRequestDetail> {
  let data: { repository?: { pullRequest?: RawPullRequest | null } | null } | null
  try {
    data = await graphql(
      DETAIL_QUERY,
      {
        owner: ref.repo.owner,
        name: ref.repo.name,
        n: ref.number,
        comments: Math.max(options.comments, 1),
        withComments: options.comments > 0,
      },
      ctx,
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw pullRequestNotFound(ref.repo, ref.number, error)
    throw error
  }
  const pull = data?.repository?.pullRequest
  if (!pull) throw pullRequestNotFound(ref.repo, ref.number)
  const threads = nodesOf(pull.reviewThreads)
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    url: pull.url,
    state: stateWord(pull.state),
    draft: pull.isDraft,
    body: pull.body ?? "",
    author: pull.author?.login ?? null,
    base: pull.baseRefName,
    head: pull.headRefName,
    head_sha: pull.headRefOid,
    head_repo: pull.headRepository?.nameWithOwner ?? null,
    cross_repository: pull.isCrossRepository,
    mergeable: stateWord(pull.mergeable),
    merge_state: stateWord(pull.mergeStateStatus),
    review_decision: stateWord(pull.reviewDecision),
    size: {
      additions: pull.additions,
      deletions: pull.deletions,
      changed_files: pull.changedFiles,
      commits: pull.commits.totalCount,
    },
    labels: nodesOf(pull.labels).map((label) => label.name),
    assignees: nodesOf(pull.assignees).map((assignee) => assignee.login),
    milestone: pull.milestone
      ? { number: pull.milestone.number, title: pull.milestone.title, due_on: pull.milestone.dueOn ?? null }
      : null,
    review_requests: nodesOf(pull.reviewRequests).flatMap(({ requestedReviewer: reviewer }) => {
      const name = reviewer?.__typename === "Team" ? reviewer.combinedSlug : reviewer?.login
      return name ? [name] : []
    }),
    reviews: nodesOf(pull.latestReviews).map((review) => ({
      author: review.author?.login ?? null,
      state: stateWord(review.state),
      submitted_at: review.submittedAt ?? null,
    })),
    unresolved_threads: threads
      .filter((thread) => !thread.isResolved)
      .map((thread) => {
        const comment = nodesOf(thread.comments)[0]
        return {
          path: thread.path,
          line: thread.line ?? null,
          outdated: thread.isOutdated,
          author: comment?.author?.login ?? null,
          body: comment?.body ?? "",
          url: comment?.url ?? null,
        }
      }),
    unresolved_threads_truncated: (pull.reviewThreads?.totalCount ?? 0) > threads.length,
    closing_issues: nodesOf(pull.closingIssuesReferences).map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: stateWord(issue.state),
      repo: issue.repository.nameWithOwner,
    })),
    auto_merge: pull.autoMergeRequest
      ? {
          method: stateWord(pull.autoMergeRequest.mergeMethod),
          enabled_by: pull.autoMergeRequest.enabledBy?.login ?? null,
        }
      : null,
    checks: summarizeChecks(nodesOf(pull.lastCommit)[0]?.commit?.statusCheckRollup?.contexts),
    projects: nodesOf(pull.projectItems).map((item) => ({
      item_id: item.id,
      archived: Boolean(item.isArchived),
      number: item.project.number,
      title: item.project.title,
      url: item.project.url,
    })),
    comments: nodesOf(pull.comments).map((comment) => ({
      author: comment.author?.login ?? null,
      created_at: comment.createdAt,
      body: comment.body ?? "",
      url: comment.url,
    })),
    comment_count: pull.comments?.totalCount ?? 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt ?? null,
    closed_at: pull.closedAt ?? null,
  }
}

/** Matching pull requests, at most `limit`; the caller builds and checks the query. */
export async function searchPullRequests(
  query: string,
  limit: number,
  ctx: RefContext,
): Promise<{ pull_requests: PullRequestRow[]; truncated: boolean }> {
  const { items, truncated } = await paginate<RawRow | Record<string, never> | null>(
    SEARCH_QUERY,
    { q: query, first: Math.min(limit, MAX_SEARCH_PAGE) },
    (data: { search?: { nodes: (RawRow | Record<string, never> | null)[] } | null } | null) => data?.search,
    { cwd: ctx.cwd, signal: ctx.signal, limit },
  )
  const pull_requests = items.filter((node): node is RawRow => node != null && "number" in node).map(row)
  return { pull_requests, truncated }
}
