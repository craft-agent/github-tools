import type { PullRequestDetail } from "../core/github/pull-requests"
import type { GhRule } from "./fake-gh"
import { gqlReply } from "./gql"

export { apiCalls, failure, searchedFor, variable } from "./issue-fixtures"

export const DETAIL = "reviewThreads\\(first"
export const SEARCH = "search\\(type:ISSUE"

export const rawRow = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/octo/hello/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  author: { login: "alice" },
  baseRefName: "main",
  headRefName: "fix",
  reviewDecision: null,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  milestone: null,
  updatedAt: "2026-11-01T00:00:00Z",
  ...extra,
})

export const pullRequestRow = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/octo/hello/pull/${number}`,
  state: "open",
  draft: false,
  author: "alice",
  base: "main",
  head: "fix",
  review_decision: null,
  labels: [],
  assignees: [],
  milestone: null,
  updated_at: "2026-11-01T00:00:00Z",
  ...extra,
})

export const rawPullRequest = (extra: Record<string, unknown> = {}) => ({
  ...rawRow(7),
  id: "PR_7",
  body: "Fix it.\nReporter text, unchanged.",
  createdAt: "2026-10-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  headRefOid: "abc123",
  headRepository: { nameWithOwner: "alice/hello" },
  isCrossRepository: true,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commits: { totalCount: 2 },
  labels: { nodes: [{ name: "bug" }, null] },
  assignees: { nodes: [{ login: "bob" }] },
  milestone: { number: 1, title: "v1", dueOn: null },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: "User", login: "carol" } },
      { requestedReviewer: { __typename: "Team", combinedSlug: "octo/core" } },
      { requestedReviewer: { __typename: "Bot", login: "bot" } },
      { requestedReviewer: { __typename: "Mannequin", login: "old-user" } },
      { requestedReviewer: null },
      null,
    ],
  },
  latestReviews: {
    nodes: [
      { author: { login: "bob" }, state: "APPROVED", submittedAt: "2026-10-02T00:00:00Z" },
      { author: null, state: "COMMENTED", submittedAt: null },
    ],
  },
  reviewThreads: {
    totalCount: 3,
    nodes: [
      {
        isResolved: false,
        isOutdated: true,
        path: "src/a.ts",
        line: null,
        comments: {
          nodes: [
            { author: { login: "bob" }, body: "Please fix", url: "https://github.com/octo/hello/pull/7#discussion_r1" },
          ],
        },
      },
      { isResolved: true, isOutdated: false, path: "src/b.ts", line: 2, comments: { nodes: [] } },
    ],
  },
  closingIssuesReferences: {
    nodes: [
      {
        number: 4,
        title: "Bug",
        url: "https://github.com/octo/hello/issues/4",
        state: "OPEN",
        repository: { nameWithOwner: "octo/hello" },
      },
    ],
  },
  autoMergeRequest: { mergeMethod: "SQUASH", enabledBy: { login: "alice" } },
  lastCommit: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 2,
              pageInfo: { hasNextPage: false },
              nodes: [
                { __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED", isRequired: true },
                { __typename: "StatusContext", state: "SUCCESS", isRequired: false },
              ],
            },
          },
        },
      },
    ],
  },
  projectItems: {
    nodes: [
      {
        id: "PVTI_1",
        isArchived: false,
        project: { number: 1, title: "Roadmap", url: "https://github.com/orgs/octo/projects/1" },
      },
    ],
  },
  comments: {
    totalCount: 9,
    nodes: [
      {
        author: null,
        createdAt: "2026-10-03T00:00:00Z",
        body: null,
        url: "https://github.com/octo/hello/pull/7#issuecomment-1",
      },
    ],
  },
  ...extra,
})

export const EXPECTED_PULL_REQUEST: PullRequestDetail = {
  id: "PR_7",
  number: 7,
  title: "Pull request 7",
  url: "https://github.com/octo/hello/pull/7",
  state: "open",
  draft: false,
  body: "Fix it.\nReporter text, unchanged.",
  author: "alice",
  base: "main",
  head: "fix",
  head_sha: "abc123",
  head_repo: "alice/hello",
  cross_repository: true,
  mergeable: "mergeable",
  merge_state: "clean",
  review_decision: "approved",
  size: { additions: 10, deletions: 2, changed_files: 3, commits: 2 },
  labels: ["bug"],
  assignees: ["bob"],
  milestone: { number: 1, title: "v1", due_on: null },
  review_requests: ["carol", "octo/core", "bot", "old-user"],
  reviews: [
    { author: "bob", state: "approved", submitted_at: "2026-10-02T00:00:00Z" },
    { author: null, state: "commented", submitted_at: null },
  ],
  unresolved_threads: [
    {
      path: "src/a.ts",
      line: null,
      outdated: true,
      author: "bob",
      body: "Please fix",
      url: "https://github.com/octo/hello/pull/7#discussion_r1",
    },
  ],
  unresolved_threads_truncated: true,
  closing_issues: [
    { number: 4, title: "Bug", url: "https://github.com/octo/hello/issues/4", state: "open", repo: "octo/hello" },
  ],
  auto_merge: { method: "squash", enabled_by: "alice" },
  checks: {
    overall: "fail",
    pass: 1,
    fail: 1,
    pending: 0,
    skipping: 0,
    required_fail: 1,
    required_pending: 0,
    truncated: false,
  },
  projects: [
    { item_id: "PVTI_1", archived: false, number: 1, title: "Roadmap", url: "https://github.com/orgs/octo/projects/1" },
  ],
  comments: [
    {
      author: null,
      created_at: "2026-10-03T00:00:00Z",
      body: "",
      url: "https://github.com/octo/hello/pull/7#issuecomment-1",
    },
  ],
  comment_count: 9,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  merged_at: null,
  closed_at: null,
}

export const detailRule = (pullRequest: unknown = rawPullRequest()): GhRule => ({
  match: DETAIL,
  stdout: gqlReply({ repository: { pullRequest } }),
})
/** Tokens only the checks query, the head query, a job log read, a run listing and a files page hold, for fake `gh` rules. */
export const CHECKS = "checkSuite\\{workflowRun"
export const HEAD = "headRefOid changedFiles"
export const RUN_VIEW = "^run view"
export const RUN_LIST = "^run list"
export const FILES = "pulls/\\d+/files"

/** A GitHub Actions check run as GitHub's GraphQL replies with it; `job` is its job id. */
export const rawCheckRun = (name: string, job: number, extra: Record<string, unknown> = {}) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: false,
  detailsUrl: `https://github.com/octo/hello/actions/runs/1/job/${job}`,
  databaseId: job,
  checkSuite: { workflowRun: { databaseId: 1, workflow: { name: "CI" } } },
  ...extra,
})

export const rawStatusContext = (context: string, extra: Record<string, unknown> = {}) => ({
  __typename: "StatusContext",
  context,
  state: "SUCCESS",
  isRequired: false,
  targetUrl: null,
  description: null,
  ...extra,
})

/** A pull request as the checks query replies with it. */
export const rawChecksPullRequest = (nodes: unknown[], extra: Record<string, unknown> = {}, hasNextPage = false) => ({
  number: 7,
  url: "https://github.com/octo/hello/pull/7",
  state: "OPEN",
  isDraft: false,
  headRefName: "fix",
  headRefOid: "abc123",
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } } } }] },
  ...extra,
})

export const checksRule = (pullRequest: unknown, times?: number): GhRule => ({
  match: CHECKS,
  stdout: gqlReply({ repository: { pullRequest } }),
  times,
})

/** A job log line as `gh run view --log-failed` prints it: job, step and a timestamped text, separated by tabs. */
export const logLine = (text: string, job = "build", step = "Run tests") =>
  `${job}\t${step}\t2026-11-01T00:00:00.1234567Z ${text}`

export const headRule = (changedFiles: number): GhRule => ({
  match: HEAD,
  stdout: gqlReply({ repository: { pullRequest: { headRefOid: "abc123", changedFiles, state: "OPEN" } } }),
})

/** A file as GitHub's REST API lists it. */
export const rawFile = (filename: string, extra: Record<string, unknown> = {}) => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: `@@ -1 +1 @@\n+${filename}`,
  ...extra,
})

export const filesRule = (page: number, files: unknown[]): GhRule => ({
  match: `${FILES}\\?per_page=100&page=${page}$`,
  stdout: JSON.stringify(files),
})

export const searchPage = (nodes: unknown[], next: string | null = null) =>
  gqlReply({ search: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } })
export const searchRule = (nodes: unknown[] = []): GhRule => ({ match: SEARCH, stdout: searchPage(nodes) })
