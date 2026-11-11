import { ToolError } from "../errors"
import { graphql } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { PROJECT_FIELDS, linkedBoards, toBoard, type Board, type BoardOwnerType, type RawBoard } from "./projects"

/** Making a board, and linking it to a repository or unlinking it. */

/** Who a new board belongs to. */
export type BoardOwner = { id: string; login: string; type: BoardOwnerType }

const OWNER_QUERY = "query($login:String!){repositoryOwner(login:$login){__typename id login}}"
const CREATE_BOARD = `mutation($owner:ID!,$title:String!){createProjectV2(input:{ownerId:$owner,title:$title}){projectV2{${PROJECT_FIELDS}}}}`
const COPY_BOARD = `mutation($project:ID!,$owner:ID!,$title:String!){copyProjectV2(input:{projectId:$project,ownerId:$owner,title:$title,includeDraftIssues:false}){projectV2{${PROJECT_FIELDS}}}}`
const linkMutation = (name: string) =>
  `mutation($project:ID!,$repo:ID!){${name}(input:{projectId:$project,repositoryId:$repo}){repository{id}}}`
const LINK = linkMutation("linkProjectV2ToRepository")
const UNLINK = linkMutation("unlinkProjectV2FromRepository")

type BoardReply = { projectV2?: RawBoard | null } | null

/** The user or organization with this login; one that does not exist or cannot be seen is `not_found`. */
export async function readBoardOwner(login: string, ctx: RefContext): Promise<BoardOwner> {
  const data = await graphql<{
    repositoryOwner?: { __typename?: string; id?: string; login?: string } | null
  } | null>(OWNER_QUERY, { login }, ctx)
  const owner = data?.repositoryOwner
  if (!owner?.id || (owner.__typename !== "User" && owner.__typename !== "Organization")) {
    throw new ToolError("not_found", `No user or organization named ${login} was found, or the viewer cannot see it.`)
  }
  return {
    id: owner.id,
    login: owner.login ?? login,
    type: owner.__typename === "Organization" ? "organization" : "user",
  }
}

function boardOf(reply: BoardReply | undefined, title: string): Board {
  if (!reply?.projectV2?.id)
    throw new ToolError("upstream_error", `GitHub did not return the board "${title}" it made.`)
  return toBoard(reply.projectV2)
}

/** Makes an empty board titled `title` for `owner`. */
export async function createBoard(owner: BoardOwner, title: string, ctx: RefContext): Promise<Board> {
  const data = await graphql<{ createProjectV2?: BoardReply } | null>(CREATE_BOARD, { owner: owner.id, title }, ctx)
  return boardOf(data?.createProjectV2, title)
}

/** Copies the board with this node ID, without its draft items, into a new board titled `title` for `owner`. */
export async function copyBoard(templateId: string, owner: BoardOwner, title: string, ctx: RefContext): Promise<Board> {
  const data = await graphql<{ copyProjectV2?: BoardReply } | null>(
    COPY_BOARD,
    { project: templateId, owner: owner.id, title },
    ctx,
  )
  return boardOf(data?.copyProjectV2, title)
}

/**
 * Throws `invalid_argument` unless the board's owner is the repository's
 * (logins compared without regard to case): GitHub refuses to link any other
 * board. `board` names the board in the message.
 */
export function assertSameOwner(board: { name: string; owner: string }, repo: RepoName): void {
  if (board.owner.toLowerCase() === repo.owner.toLowerCase()) return
  throw new ToolError(
    "invalid_argument",
    `A board can only be linked to a repository of its own owner: ${board.name} belongs to ${board.owner}, ${repo.full} to ${repo.owner}.`,
  )
}

/** Whether the board is linked to the repository, from the boards the repository lists. */
export async function isLinked(board: Pick<Board, "id">, repo: RepoName, ctx: RefContext): Promise<boolean> {
  const { boards } = await linkedBoards(repo, ctx)
  return boards.some((linked) => linked.id === board.id)
}

/** Links the board to the repository with this node ID, or unlinks it. */
export async function setLinked(
  board: Pick<Board, "id">,
  repoId: string,
  linked: boolean,
  ctx: RefContext,
): Promise<void> {
  await graphql(linked ? LINK : UNLINK, { project: board.id, repo: repoId }, ctx)
}
