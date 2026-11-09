import { z } from "zod"
import { assertSameOwner, isLinked, setLinked } from "../github/board-setup"
import { assertBoardWritable, boardResource, resolveBoard } from "../github/projects"
import { resolveRepo } from "../refs"
import { defineTool, type ToolContext } from "../tool"
import { writableContext } from "../write-support"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...BOARD_SELECTION,
  repo: z
    .string()
    .optional()
    .describe(
      "owner/name of the repository to link or unlink; defaults to the working tree's repository (its origin). Also where the board lookup starts.",
    ),
})

const output = z.object({
  project: boardSummarySchema,
  repo: z.string().describe("owner/name of the repository."),
  changed: z.boolean().describe("false when the board was already in the wanted state."),
})

type Args = z.output<typeof input>

/** Puts the board in the wanted state, writing only when it is not in it. */
async function setLink(args: Args, linked: boolean, ctx: ToolContext) {
  const repo = await resolveRepo(args.repo, ctx)
  const { project } = await resolveBoard({ ...args, repo: repo.full }, ctx)
  if (linked) assertSameOwner({ name: boardResource(project), owner: project.owner }, repo)
  assertBoardWritable(project)
  const context = await writableContext(repo, ctx)
  const changed = (await isLinked(project, context.repo, ctx)) !== linked
  if (changed) await setLinked(project, context.id, linked, ctx)
  return { project: boardSummary(project), repo: context.repo.full, changed }
}

export const projectLink = defineTool({
  id: "github_project_link",
  title: "Link a GitHub project to a repository",
  intent: "About to link a GitHub project to a repository",
  description: [
    "Link a project board to a repository, so the board lookup finds it among that repository's boards. The viewer must be able to update the board and write to the repository; a board that is already linked is left as it is (changed: false). GitHub links only boards of the repository's own owner, so a board of another user or organization is invalid_argument, before anything is written.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board", repo: "repo" },
  input,
  output,
  execute: (args, ctx) => setLink(args, true, ctx),
})

export const projectUnlink = defineTool({
  id: "github_project_unlink",
  title: "Unlink a GitHub project from a repository",
  intent: "About to unlink a GitHub project from a repository",
  description: [
    "Unlink a project board from a repository. The viewer must be able to update the board and write to the repository; a board that is not linked is left as it is (changed: false). Nothing on the board is deleted.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board", repo: "repo" },
  input,
  output,
  execute: (args, ctx) => setLink(args, false, ctx),
})
