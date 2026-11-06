import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { sent } from "./write-fixtures"

/** Replies of GitHub the board setup tools meet: GraphQL mutations, the REST fields and views of a board, and the writes a fake `gh` saw. */

/** The end of a variable on the joined command line: another argument follows, or nothing. */
const END = "(?: |$)"

/** A GraphQL mutation by its name, replying `data`. */
export const mutationRule = (name: string, data: unknown, times?: number): GhRule => ({
  match: `${name}\\(input`,
  stdout: gqlReply(data),
  times,
})

/** What GitHub replies with for a field it made or changed. */
export const rawField = (id: string, name: string, dataType: string, options?: unknown[]) => ({
  __typename: options ? "ProjectV2SingleSelectField" : "ProjectV2Field",
  id,
  name,
  dataType,
  ...(options ? { options } : {}),
})

export const rawOption = (id: string, name: string, color = "GRAY", description = "") => ({
  id,
  name,
  color,
  description,
})

/** A field column that mirrors an organization's single-select issue field. */
export const rawIssueFieldSingleSelect = (
  id: string,
  name: string,
  options: { id: string; name: string; color?: string; description?: string | null }[],
) => ({
  __typename: "ProjectV2SingleSelectField",
  id,
  name,
  dataType: "SINGLE_SELECT",
  options: [],
  isIssueField: true,
  issueField: {
    __typename: "IssueFieldSingleSelect",
    options,
  },
})

/** A field column that mirrors an organization's date issue field. */
export const rawIssueFieldDate = (id: string, name: string) => ({
  __typename: "ProjectV2Field",
  id,
  name,
  dataType: "DATE",
  isIssueField: true,
  issueField: {
    __typename: "IssueFieldDate",
  },
})

/** The reply of creating (or changing) a field, which the tool reports as made; `named` picks the call that makes the field of that name. */
export const fieldMutationRule = (
  name: "createProjectV2Field" | "updateProjectV2Field",
  field: unknown,
  named?: string,
): GhRule => {
  const rule = mutationRule(name, { [name]: { projectV2Field: field } })
  return named === undefined ? rule : { ...rule, match: `${rule.match}[\\s\\S]*-f name=${named}${END}` }
}

/** The user or organization a board is made for, as the owner query replies with it. */
export const boardOwnerRule = (login: string, typename: "User" | "Organization", id = `O_${login}`): GhRule => ({
  match: `repositoryOwner\\(login:\\$login\\)\\{__typename id login\\}[\\s\\S]*login=${login}${END}`,
  stdout: gqlReply({ repositoryOwner: { __typename: typename, id, login } }),
})

/** The issue fields of the organization `login` as the owner query replies with them; `null` nodes answer as a user, who has none. */
export const organizationIssueFieldsRule = (login: string, nodes: unknown[] | null): GhRule => ({
  match: `repositoryOwner\\(login:\\$login\\)\\{__typename \\.\\.\\. on Organization\\{issueFields[\\s\\S]*login=${login}${END}`,
  stdout: gqlReply({
    repositoryOwner: nodes === null ? { __typename: "User" } : { __typename: "Organization", issueFields: { nodes } },
  }),
})

/** The fields of a board as its REST route lists them: one page. */
export const restFieldsRule = (root: "orgs" | "users", login: string, number: number, names: string[]): GhRule => ({
  match: `^api -H X-GitHub-Api-Version: 2026-03-10 ${root}/${login}/projectsV2/${number}/fields\\?per_page=100 --paginate --slurp$`,
  stdout: JSON.stringify([names.map((name, index) => ({ id: index + 1, name }))]),
})

/** The REST route that makes a view; replies with its number and node ID (`PVTV_<number>`). */
export const restViewRule = (path: string, number = 5, times?: number): GhRule => ({
  match: `^api --method POST -H X-GitHub-Api-Version: 2026-03-10 ${path} --input -$`,
  stdout: JSON.stringify({ number, node_id: `PVTV_${number}` }),
  times,
})

/** The same fields as `restFieldsRule` lists, as GraphQL replies with them: the id of the nth is `GF<n>`. */
export const graphqlFieldNodes = (names: string[]): unknown[] =>
  names.map((name, index) => rawField(`GF${index + 1}`, name, "TEXT"))

/** The GraphQL update that puts a view's columns in order. */
export const updateViewRule = (failure: Pick<GhRule, "stderr" | "code"> = {}): GhRule => ({
  ...mutationRule("updateProjectV2View", { updateProjectV2View: { projectV2View: { id: "PVTV_5" } } }),
  ...failure,
})

/** The numeric id of a user, which the REST route of their views takes. */
export const userIdRule = (login: string, id: number): GhRule => ({
  match: `^api users/${login} --jq .id$`,
  stdout: `${id}\n`,
})

/** The text of the GraphQL query or mutation one call ran. */
export function queryOf(args: string[]): string {
  return args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? ""
}

/** The GraphQL mutations the fake saw, in order. */
export function mutationsSent(installed: FakeGh): string[][] {
  return sent(installed).filter((args) => queryOf(args).startsWith("mutation"))
}

/** Every write the fake saw, in order: a mutation by its name, a REST write as `POST <path>`. */
export function writeLog(installed: FakeGh): string[] {
  return sent(installed).flatMap((args) => {
    const mutation = /^mutation\([^)]*\)\{(\w+)/.exec(queryOf(args))?.[1]
    if (mutation) return [mutation]
    return args.includes("POST") ? [`POST ${args.find((arg) => arg.includes("/projectsV2/"))}`] : []
  })
}

/** The REST writes the fake saw with what each was given on stdin, in order. */
export function restWrites(installed: FakeGh): { args: string[]; body: unknown }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) => (args.includes("POST") ? [{ args, body: JSON.parse(stdins[index] ?? "null") }] : []))
}
