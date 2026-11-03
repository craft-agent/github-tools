import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"

/** Replies of GitHub the write tools meet, and a view of the writes a fake `gh` saw. */

/** Each is a token only one of the queries holds, so a fake `gh` rule can pick it. */
export const ISSUE_TYPES = "issueTypes\\(first"
export const LABEL = "label\\(name:"

/** The owner has no Issue Type, as a user does not. */
export const noIssueTypesRule = (): GhRule => ({
  match: ISSUE_TYPES,
  stdout: gqlReply({ repositoryOwner: null }),
})

/** The owner is an organization with these Issue Types enabled. */
export const issueTypesRule = (...names: string[]): GhRule => ({
  match: ISSUE_TYPES,
  stdout: gqlReply({
    repositoryOwner: {
      __typename: "Organization",
      issueTypes: { nodes: names.map((name) => ({ name, isEnabled: true })) },
    },
  }),
})

export const labelRule = (exists: boolean): GhRule => ({
  match: LABEL,
  stdout: gqlReply({ repository: { label: exists ? { id: "LA_1" } : null } }),
})

/** Every call the tool made to GitHub; the fake's version check is not one. */
export function sent(installed: FakeGh): string[][] {
  return installed.calls().filter((args) => args[0] !== "--version")
}

/** The `gh issue` and `gh label` calls with their stdin, in order. */
export function commands(installed: FakeGh): { args: string[]; stdin: string }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) =>
      args[0] === "issue" || args[0] === "label" ? [{ args, stdin: stdins[index] ?? "" }] : [],
    )
}
