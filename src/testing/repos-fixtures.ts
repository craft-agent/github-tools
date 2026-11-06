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
