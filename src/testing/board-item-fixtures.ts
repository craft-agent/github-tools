import type { GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { connection } from "./project-fixtures"

/** What GitHub replies with for the items of a board, and the fake `gh` rules that pick the items query. */

export const ITEMS = "items\\(first:100"

export const itemsPage = (nodes: unknown[], next: string | null = null) =>
  gqlReply({ node: { items: connection(nodes, next) } })

export const itemsRule = (nodes: unknown[]): GhRule => ({ match: ITEMS, stdout: itemsPage(nodes) })

/** A board item as GitHub's GraphQL replies with it. */
export const rawItem = (
  id: string,
  content: unknown,
  fieldValues: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({ id, isArchived: false, fieldValues: { nodes: fieldValues }, content, ...extra })

export const rawIssueContent = (number: number, extra: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  number,
  title: `Issue ${number}`,
  url: `https://github.com/octo/hello/issues/${number}`,
  issueState: "OPEN",
  repository: { nameWithOwner: "octo/hello" },
  issueType: null,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  parent: null,
  subIssuesSummary: null,
  ...extra,
})

export const rawPullContent = (number: number, extra: Record<string, unknown> = {}) => ({
  __typename: "PullRequest",
  number,
  title: `Pull ${number}`,
  url: `https://github.com/octo/hello/pull/${number}`,
  pullRequestState: "MERGED",
  repository: { nameWithOwner: "octo/hello" },
  labels: { nodes: [{ name: "ui" }] },
  assignees: { nodes: [{ login: "bob" }] },
  ...extra,
})

export const rawDraftContent = (title: string, body: string | null = null) => ({
  __typename: "DraftIssue",
  title,
  body,
})

/** A single-select value of the `Status` field. */
export const statusValue = (name: string) => ({ name, field: { name: "Status" } })

/** A board item field value mirroring an organization issue field. */
export const issueFieldValue = (
  name: string,
  issueFieldValue: {
    __typename?: string
    value?: string | number | null
    name?: string | null
    options?: ({ name?: string | null } | null)[] | null
  } | null,
) => ({
  __typename: "ProjectV2ItemIssueFieldValue",
  field: { name },
  issueFieldValue,
})
