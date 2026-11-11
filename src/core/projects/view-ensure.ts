import { z } from "zod"
import { ToolError } from "../errors"
import {
  VIEW_LAYOUTS,
  checkViewRequest,
  createView,
  viewFieldReaders,
  type ViewLayout,
} from "../github/board-view-setup"
import { boardViewSchema, readBoardViews } from "../github/board-fields"
import { assertBoardWritable, resolveBoard, sameTitle } from "../github/projects"
import { githubTargets } from "../github/targets"
import { defineTool, type CallFact, type CallValue } from "../tool"
import { ALREADY_THERE } from "./describe-support"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

/** The `Layout` fact's words for the layouts. */
const LAYOUT_WORDS: Readonly<Record<ViewLayout, string>> = { table: "Table", board: "Board", roadmap: "Roadmap" }

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
  targets: githubTargets({ project: "board" }),
  async describe(args, ctx) {
    const request = checkViewRequest(args)
    const { project } = await resolveBoard(args, ctx)
    assertBoardWritable(project)
    const headline = {
      text: "About to make sure the view {name} is on the project board",
      values: { name: request.name },
    }
    const existing = (await readBoardViews(project.id, ctx)).find((view) => sameTitle(view.name, request.name))
    if (existing) return { headline, facts: [{ label: "State", value: { text: ALREADY_THERE } }] }

    const wanted = [...(request.fields ?? []), request.group_by, request.column_by, request.sort_by].filter(
      (name) => name !== undefined,
    )
    const known = await viewFieldReaders(project, ctx).rest()
    const unknown = wanted.filter((name) => !known.some((field) => sameTitle(field.name, name)))
    if (unknown.length > 0) {
      throw new ToolError(
        "invalid_argument",
        `The board has no field ${unknown.map((name) => `"${name}"`).join(", ")}; its fields are ${known.map((field) => field.name).join(", ")}.`,
      )
    }

    const facts: CallFact[] = [
      { label: "Board", value: project.title },
      { label: "Layout", value: { text: LAYOUT_WORDS[request.layout] } },
    ]
    if (request.filter) facts.push({ label: "Filter", value: request.filter })
    if (request.fields?.length) facts.push({ label: "Fields", value: request.fields.join(", ") })
    if (request.group_by) facts.push({ label: "Grouped by", value: request.group_by })
    if (request.column_by) facts.push({ label: "Columns by", value: request.column_by })
    if (request.sort_by) {
      const sort: CallValue | string = request.sort_desc
        ? { text: "{field} (descending)", values: { field: request.sort_by } }
        : request.sort_by
      facts.push({ label: "Sorted by", value: sort })
    }
    return { headline, facts }
  },
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
