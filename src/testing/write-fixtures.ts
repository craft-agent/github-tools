import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"

/** Replies of GitHub the write tools meet, and a view of the writes a fake `gh` saw. */

export const ORIGIN = "https://github.com/octo/hello.git"

/** The node id `issueFieldsRule` gives the issue unless it is told another. */
export const ISSUE_ID = "I_12"

/** Each is a token only one of the queries holds, so a fake `gh` rule can pick it. */
export const REPOSITORY = "viewerPermission"
export const ISSUE_TYPES = "issueTypes\\(first"
export const LABEL = "label\\(name:"
export const MILESTONES = "milestones\\?state=all"
export const MILESTONE_CREATE = "-X POST"
export const FIELDS = "labels\\(first:100\\)"
export const HEADING = "id title state stateReason"
export const ISSUE_FIELD_DEFINITIONS = "issueFields\\(first"
export const ISSUE_FIELD_VALUES = "issueFieldValues\\(first"
export const ISSUE_FIELD_MUTATION = "setIssueFieldValue"

/** The repository query's reply: `octo/hello` unless `repo` says otherwise, owned by the viewer unless `viewer` does. */
export function repositoryRule(options: { repo?: string; permission?: string | null; viewer?: string } = {}): GhRule {
  const repo = options.repo ?? "octo/hello"
  const owner = repo.split("/")[0]!
  return {
    match: REPOSITORY,
    stdout: gqlReply({
      viewer: { login: options.viewer ?? owner },
      repository: {
        id: "R_1",
        nameWithOwner: repo,
        viewerPermission: options.permission === undefined ? "WRITE" : options.permission,
        owner: { __typename: "User", login: owner },
      },
    }),
  }
}

/** The owner has no Issue Type, as a user does not. */
export const noIssueTypesRule = (): GhRule => ({ match: ISSUE_TYPES, stdout: gqlReply({ repositoryOwner: null }) })

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

/** The milestones of the repository, as the REST list returns them (one page). */
export const milestonesRule = (...titles: string[]): GhRule => ({
  match: MILESTONES,
  stdout: JSON.stringify([titles.map((title, index) => ({ number: index + 1, title }))]),
})

export const milestoneCreatedRule = (number: number, title: string): GhRule => ({
  match: MILESTONE_CREATE,
  stdout: JSON.stringify({ number, title }),
})

/** What `gh issue edit` prints: the issue's URL. */
export const editedRule = (number: number): GhRule => ({
  match: "^issue edit",
  stdout: `https://github.com/octo/hello/issues/${number}\n`,
})

/** The rules most calls need, after the ones a test adds: write permission, no Issue Types and any edit succeeding. */
export const writeRules = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  repositoryRule(),
  noIssueTypesRule(),
  { match: "^issue edit" },
]

/** The node id, state, body and labels of the issue, as the fields query returns them. */
export const issueFieldsRule = (
  fields: { id?: string; state?: string; stateReason?: string | null; body?: string; labels?: string[] } = {},
): GhRule => ({
  match: FIELDS,
  stdout: gqlReply({
    repository: {
      issue: {
        id: fields.id ?? ISSUE_ID,
        state: fields.state ?? "OPEN",
        stateReason: fields.stateReason ?? null,
        body: fields.body ?? "",
        labels: { nodes: (fields.labels ?? []).map((name) => ({ name })) },
      },
    },
  }),
})

/** The node id, title, state and reason of the issue, as the heading query returns them. */
export const issueHeadingRule = (
  heading: { id?: string; title?: string; state?: string; stateReason?: string | null } = {},
): GhRule => ({
  match: HEADING,
  stdout: gqlReply({
    repository: {
      issue: {
        id: heading.id ?? ISSUE_ID,
        title: heading.title ?? "Crash on save",
        state: heading.state ?? "OPEN",
        stateReason: heading.stateReason ?? null,
      },
    },
  }),
})

/** An organization's issue fields as the definitions query returns them: one of each type. */
export const ISSUE_FIELD_NODES = [
  {
    __typename: "IssueFieldSingleSelect",
    id: "IF_priority",
    name: "Priority",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "IFO_high", name: "High" },
      { id: "IFO_low", name: "Low" },
    ],
  },
  { __typename: "IssueFieldNumber", id: "IF_effort", name: "Effort", dataType: "NUMBER" },
  { __typename: "IssueFieldDate", id: "IF_target", name: "Target date", dataType: "DATE" },
  { __typename: "IssueFieldText", id: "IF_sprint", name: "Sprint", dataType: "TEXT" },
  {
    __typename: "IssueFieldMultiSelect",
    id: "IF_components",
    name: "Components",
    dataType: "MULTI_SELECT",
    options: [
      { id: "IFO_ui", name: "UI" },
      { id: "IFO_api", name: "API" },
    ],
  },
]

/** The repository's issue fields: these definitions, or none (`null`, as a personal account's repository answers). */
export const issueFieldDefinitionsRule = (nodes: unknown[] | null = ISSUE_FIELD_NODES): GhRule => ({
  match: ISSUE_FIELD_DEFINITIONS,
  stdout: gqlReply({ repository: { issueFields: nodes === null ? null : { nodes } } }),
})

/** The mutation that sets and clears issue fields succeeding. */
export const issueFieldsSetRule = (): GhRule => ({
  match: ISSUE_FIELD_MUTATION,
  stdout: gqlReply({ setIssueFieldValue: { issueFieldValues: [] } }),
})

/** The values of the issue's fields as the read after a write returns them. */
export const issueFieldValuesRule = (nodes: unknown[]): GhRule => ({
  match: ISSUE_FIELD_VALUES,
  stdout: gqlReply({ node: { issueFieldValues: { nodes } } }),
})

/** What `gh issue create` prints: the new issue's URL. */
export const createdRule = (number: number, repo = "octo/hello"): GhRule => ({
  match: "^issue create",
  stdout: `https://github.com/${repo}/issues/${number}\n`,
})

/** Every call the tool made to GitHub; the fake's version check is not one. */
export function sent(installed: FakeGh): string[][] {
  return installed.calls().filter((args) => args[0] !== "--version")
}

/** The calls that can change something: everything but the GraphQL reads and the REST list. */
export function writes(installed: FakeGh): string[][] {
  return sent(installed).filter((args) => args[0] !== "api" || args.includes("POST"))
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
