import type { GraphQLErrorEntry } from "../core/gh"

/** The stdout of a successful `gh api graphql` call. */
export const gqlReply = (data: unknown): string => JSON.stringify({ data })

/** The stdout of a GraphQL reply that carries errors, with whatever `data` came with them. */
export const gqlErrors = (errors: GraphQLErrorEntry[], data?: unknown): string =>
  JSON.stringify({ data: data ?? null, errors })
