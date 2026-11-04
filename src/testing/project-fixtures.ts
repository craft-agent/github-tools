import type { Board } from "../core/github/projects"
import type { GhRule } from "./fake-gh"
import { gqlReply } from "./gql"

/** What GitHub replies with for project boards, and the fake `gh` rules that pick one query and its variables. */

type OwnerRoot = Board["owner_type"]
type OwnerTypename = "Organization" | "User"

/** The end of a variable on the joined command line: another argument follows, or nothing. */
const END = "(?: |$)"

/** A connection of one page, with a cursor when more follow. */
export const connection = (nodes: unknown[], next: string | null = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
})

/** A board as GitHub's GraphQL replies with it; by default `octo`'s open board that the viewer may update. */
export const rawBoard = (number: number, extra: Record<string, unknown> = {}) => ({
  id: `PVT_${number}`,
  number,
  title: "Roadmap",
  url: `https://github.com/orgs/octo/projects/${number}`,
  closed: false,
  viewerCanUpdate: true,
  owner: { __typename: "Organization", login: "octo" },
  ...extra,
})

/** A board owned by the user `alice`, the viewer. */
export const rawUserBoard = (number: number, extra: Record<string, unknown> = {}) =>
  rawBoard(number, {
    url: `https://github.com/users/alice/projects/${number}`,
    owner: { __typename: "User", login: "alice" },
    ...extra,
  })

/** What a tool makes of `rawBoard(number)`. */
export const board = (number: number, extra: Partial<Board> = {}): Board => ({
  id: `PVT_${number}`,
  number,
  title: "Roadmap",
  url: `https://github.com/orgs/octo/projects/${number}`,
  owner: "octo",
  owner_type: "organization",
  closed: false,
  can_update: true,
  ...extra,
})

export const ownerTypeRule = (login: string, typename: OwnerTypename | null): GhRule => ({
  match: `repositoryOwner\\(login:\\$login\\)\\{__typename\\}[\\s\\S]*login=${login}${END}`,
  stdout: gqlReply({ repositoryOwner: typename && { __typename: typename } }),
})

export const viewerRule = (login = "alice"): GhRule => ({
  match: "query\\{viewer\\{login\\}\\}",
  stdout: gqlReply({ viewer: { login } }),
})

export const namedBoardRule = (root: OwnerRoot, login: string, number: number, found: unknown): GhRule => ({
  match: `${root}\\(login:\\$login\\)\\{projectV2\\(number:\\$n\\)[\\s\\S]*login=${login} -F n=${number}${END}`,
  stdout: gqlReply({ [root]: { projectV2: found } }),
})

export const ownerBoardsRule = (
  root: OwnerRoot,
  login: string,
  boards: unknown[],
  next: string | null = null,
): GhRule => ({
  match: `${root}\\(login:\\$login\\)\\{projectsV2\\(first:100[\\s\\S]*login=${login}${END}`,
  stdout: gqlReply({ [root]: { projectsV2: connection(boards, next) } }),
})

export const viewerBoardsRule = (boards: unknown[], next: string | null = null): GhRule => ({
  match: "viewer\\{projectsV2\\(first:100",
  stdout: gqlReply({ viewer: { projectsV2: connection(boards, next) } }),
})

export const linkedBoardsRule = (
  owner: string,
  name: string,
  boards: unknown[],
  ownerTypename: OwnerTypename = "Organization",
): GhRule => ({
  match: `owner\\{__typename login\\} projectsV2[\\s\\S]*owner=${owner} -f name=${name}${END}`,
  stdout: gqlReply({
    repository: { owner: { __typename: ownerTypename, login: owner }, projectsV2: connection(boards) },
  }),
})

export const itemBoardRule = (itemId: string, project: unknown): GhRule => ({
  match: `on ProjectV2Item\\{project[\\s\\S]*id=${itemId}${END}`,
  stdout: gqlReply({ node: project && { project } }),
})

export const FIELDS = "fields\\(first:100"
export const VIEWS = "views\\(first:100"

export const fieldsRule = (nodes: unknown[]): GhRule => ({
  match: FIELDS,
  stdout: gqlReply({ node: { fields: connection(nodes) } }),
})

export const viewsRule = (nodes: unknown[]): GhRule => ({
  match: VIEWS,
  stdout: gqlReply({ node: { views: connection(nodes) } }),
})

/** The rules that find `octo`'s board `number`, as `project: "octo/<number>"` names it. */
export const octoBoardRules = (number: number, extra: Record<string, unknown> = {}): GhRule[] => [
  ownerTypeRule("octo", "Organization"),
  namedBoardRule("organization", "octo", number, rawBoard(number, extra)),
]
