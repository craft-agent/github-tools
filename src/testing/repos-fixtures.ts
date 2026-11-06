import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { sent } from "./write-fixtures"

/** Replies of GitHub the repository read tools meet, and a view of the GraphQL calls a fake `gh` saw. */

type Extra = Record<string, unknown>

/** One GraphQL call: its query text and the variables sent as `-f` / `-F` flags. */
export type GraphqlCall = { query: string; vars: Record<string, string> }

export function graphqlCalls(installed: FakeGh): GraphqlCall[] {
  return sent(installed).flatMap((args) => {
    if (args[0] !== "api" || args[1] !== "graphql") return []
    const vars: Record<string, string> = {}
    let query = ""
    for (let index = 2; index < args.length; index += 2) {
      const [name, value] = args[index + 1]!.split(/=(.*)/s)
      if (name === "query") query = value!
      else vars[name!] = value!
    }
    return [{ query, vars }]
  })
}

/** The paths of the REST calls that went out. */
export const restPaths = (installed: FakeGh): string[] =>
  sent(installed).flatMap((args) => (args[0] === "api" && args[1] !== "graphql" ? [args[1]!] : []))

/** A GraphQL reply of `octo/hello` that holds `repository`. */
export const repositoryReply = (repository: unknown): string => gqlReply({ repository })

/** One page of a connection, `next` being the cursor of the page after it (none for the last). */
export const page = (nodes: unknown[], next: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
})

/** A GraphQL rule for a call whose query holds `token`, answering `stdout`; `times` limits how many calls it answers. */
export const graphqlRule = (token: string, data: unknown, times?: number): GhRule => ({
  match: token,
  stdout: gqlReply(data),
  times,
})

/** A call `gh api` reports as failed with the HTTP status on stderr and GitHub's body on stdout. */
export const restFailure = (match: string, status: string, body: Extra = {}): GhRule => ({
  match,
  stderr: `gh: ${status}`,
  stdout: JSON.stringify(body),
  code: 1,
})

export const labelPages = (labels: unknown[], next: string | null = null, times?: number): GhRule =>
  graphqlRule("labels\\(first:100", { repository: { labels: page(labels, next) } }, times)

export const milestonePages = (milestones: unknown[], next: string | null = null): GhRule =>
  graphqlRule("milestones\\(first:100", { repository: { milestones: page(milestones, next) } })

export const LABEL_ROW = { name: "Bug", color: "d73a4a", description: "Something is broken" }
export const MILESTONE_ROW = {
  number: 1,
  title: "Release",
  state: "OPEN",
  dueOn: "2026-12-01T12:00:00Z",
  description: "Next release",
  openIssueCount: 2,
  closedIssueCount: 1,
  url: "https://github.com/octo/hello/milestone/1",
}

export const milestoneRest = (overrides: Extra = {}) => ({
  number: 1,
  title: "Release",
  state: "open",
  due_on: MILESTONE_ROW.dueOn,
  description: MILESTONE_ROW.description,
  html_url: MILESTONE_ROW.url,
  ...overrides,
})

/** The REST mutations with their JSON request bodies, in order. */
export function writeLog(installed: FakeGh): { args: string[]; body: unknown }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) =>
      args[0] === "api" && args.some((arg) => ["POST", "PATCH", "DELETE"].includes(arg))
        ? [{ args, body: stdins[index] ? JSON.parse(stdins[index]!) : null }]
        : [],
    )
}
