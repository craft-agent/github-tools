import { z } from "zod"
import { VIEW_LAYOUTS, checkViewRequest, createView, viewFieldReaders } from "../github/board-view-setup"
import { boardViewSchema, readBoardViews } from "../github/board-fields"
import { assertBoardWritable, resolveBoard, sameTitle } from "../github/projects"
import { defineTool } from "../tool"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  ...BOARD_SELECTION,
  name: z.string().describe("The view's name, matched without regard to case."),
  layout: z.enum(VIEW_LAYOUTS),
  filter: z.string().optional().describe('A project filter, such as "-status:Done -status:Cancelled".'),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "The fields shown, by name and in order (built-in ones too, such as Assignees or Parent issue); not for a roadmap.",
    ),
  group_by: z
    .string()
    .optional()
    .describe("A field name to group by; not Sub-issues progress or Linked pull requests."),
  column_by: z.string().optional().describe("board layout only: the field name the columns follow."),
  sort_by: z.string().optional().describe("A field name to sort by."),
  sort_desc: z.boolean().optional().describe("Sort descending (default false); needs sort_by."),
})

const output = z.object({
  project: boardSummarySchema,
  view: boardViewSchema.pick({ number: true, name: true, layout: true }),
  created: z.boolean().describe("Whether this call made the view; false when the board already had one of that name."),
})

export const projectViewEnsure = defineTool({
  id: "github_project_view_ensure",
  title: "Ensure a GitHub project view",
  intent: "About to ensure a GitHub project view exists",
  description: [
    "Make sure a saved view exists on a project board the viewer may update: a view of that name (without regard to case) is left exactly as it is, and a missing one is created through the REST API with its layout, filter, fields, sorting and grouping.",
    "A field name the board lacks, fields on a roadmap, column_by on a layout other than board, grouping by Sub-issues progress or Linked pull requests and sort_desc without sort_by are invalid_argument, before anything is written.",
    "The API cannot set a roadmap's date fields.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { project: "board" },
  input,
  output,
  async execute(args, ctx) {
    const request = checkViewRequest(args)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const existing = (await readBoardViews(project.id, ctx)).find((view) => sameTitle(view.name, request.name))
    if (existing) {
      const { number, name, layout } = existing
      return { project: boardSummary(project), view: { number, name, layout }, created: false }
    }
    const view = await createView(project, request, viewFieldReaders(project, ctx), ctx)
    return { project: boardSummary(project), view, created: true }
  },
})
