import { z } from "zod"
import {
  ensureField,
  ensureIssueFieldColumn,
  readOwnerIssueFields,
  requireIssueField,
} from "../github/board-field-setup"
import { readBoardFields, readBoardViewNodes, type BoardViewNode } from "../github/board-fields"
import {
  ViewColumnsError,
  createView,
  deleteView,
  viewFieldReaders,
  type ViewRequest,
} from "../github/board-view-setup"
import { assertSameOwner, copyBoard, createBoard, isLinked, readBoardOwner, setLinked } from "../github/board-setup"
import type { IssueFieldDefinition } from "../github/issue-fields"
import {
  CURRENT_USER,
  DEFAULT_BOARD_TITLE,
  assertBoardWritable,
  boardResource,
  given,
  givenOwner,
  ownerBoards,
  resolveBoard,
  sameTitle,
  viewerLogin,
  type Board,
} from "../github/projects"
import { writableContext, invalid } from "../write-support"
import { parseRepo, type RefContext } from "../refs"
import { StepErrors, defineTool } from "../tool"
import { PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"
import {
  BOARD_DATE_FIELDS,
  DATE_MODES,
  DEFAULT_VIEW_NAME,
  ISSUE_DATE_FIELDS,
  STATUS_REQUEST,
  standardTemplate,
  type DateMode,
} from "./template"

const input = z.object({
  owner: z.string().describe('The user or organization login that owns the board, or "@me".'),
  title: z.string().optional().describe(`The board's title (default ${DEFAULT_BOARD_TITLE}).`),
  template: z
    .string()
    .optional()
    .describe(
      "A board to copy, without its draft items, when the board has to be made: its number, owner/number or URL (a bare number or a title is looked up among owner's boards).",
    ),
  standard: z
    .boolean()
    .optional()
    .describe("Bring the board to the standard template: its fields and views (default true)."),
  dates: z
    .enum(DATE_MODES)
    .optional()
    .describe(
      '"board" (default) makes the board\'s own date fields Start and Target; "issue_fields" uses the organization\'s issue fields Start date and Target date instead, so an issue carries the same dates on every board and they are set with the issue tools (a pull request or draft has none). Organization boards only.',
    ),
  link_repo: z.string().optional().describe("owner/name of a repository to link the board to; needs write permission."),
})

const output = z.object({
  project: boardSummarySchema,
  created: z.boolean().describe("false when an open board of that owner and title was reused."),
  copied_from: z.string().nullable().describe("owner/projects/N of the board that was copied; null when none was."),
  fields: z
    .array(
      z.object({
        field: z.string(),
        created: z.boolean(),
        added_options: z.array(z.string()),
        updated_options: z
          .array(z.string())
          .describe(
            "Options of an existing field that were renamed, recolored or moved; only on a board this call made.",
          ),
      }),
    )
    .describe("The standard fields, in order."),
  views: z
    .array(z.object({ view: z.string(), created: z.boolean() }))
    .describe("The standard views, in order; created: false when the board already had one of that name."),
  deleted_default_view: z
    .boolean()
    .describe(`Whether ${DEFAULT_VIEW_NAME}, GitHub's default view, was deleted; only on a board this call made.`),
  linked: z
    .string()
    .nullable()
    .describe("owner/name of the repository the board is linked to; null when none was asked."),
  notes: z.array(z.string()).describe("What still has to be done by hand."),
  errors: z
    .record(z.string(), z.string())
    .describe("Failed steps (fields, views, default_view, link), keyed by step; {} when none."),
})

type Created = z.output<typeof output>

/** The one open board of that title among the owner's boards, if any; several are `invalid_argument`. */
function openBoardTitled(boards: readonly Board[], title: string): Board | undefined {
  const matches = boards.filter((board) => !board.closed && sameTitle(board.title, title))
  if (matches.length > 1) {
    throw invalid(
      `${matches.length} open boards titled "${title}": ${matches.map(boardResource).join(", ")}. Close or rename the extra ones, or use another title.`,
    )
  }
  return matches[0]
}

/** The standard fields; a board this call made gets exactly the standard Status options, any other only the ones it lacks. */
async function applyFields(
  board: Board,
  fresh: boolean,
  mode: DateMode,
  dates: { start: string; target: string },
  definitions: readonly IssueFieldDefinition[] | null,
  report: Created["fields"],
  ctx: RefContext,
): Promise<void> {
  const fields = await readBoardFields(board.id, ctx)
  const status = await ensureField(board, fields, STATUS_REQUEST, fresh ? "replace" : "append", ctx)
  report.push({
    field: status.field.name,
    created: status.created,
    added_options: status.added_options,
    updated_options: status.updated_options,
  })

  if (mode === "issue_fields") {
    for (const name of [dates.start, dates.target]) {
      const outcome = await ensureIssueFieldColumn(board, fields, definitions, { name, type: "date" }, ctx)
      report.push({
        field: outcome.field.name,
        created: outcome.created,
        added_options: outcome.added_options,
        updated_options: outcome.updated_options,
      })
    }
  } else {
    for (const name of [dates.start, dates.target]) {
      const outcome = await ensureField(board, fields, { name, type: "date", options: [] }, "append", ctx)
      report.push({
        field: outcome.field.name,
        created: outcome.created,
        added_options: outcome.added_options,
        updated_options: outcome.updated_options,
      })
    }
  }
}

/** The standard views the board lacks, in order; returns the views the board had before. */
async function applyViews(
  board: Board,
  templateViews: readonly ViewRequest[],
  roadmapNote: string,
  report: Created["views"],
  notes: string[],
  ctx: RefContext,
): Promise<BoardViewNode[]> {
  const before = await readBoardViewNodes(board.id, ctx)
  const readers = viewFieldReaders(board, ctx)
  for (const request of templateViews) {
    if (before.some((view) => sameTitle(view.name, request.name))) {
      report.push({ view: request.name, created: false })
      continue
    }
    try {
      await createView(board, request, readers, ctx)
    } catch (error) {
      // The view exists even though its columns could not be ordered, so it is reported beside the step's error.
      if (error instanceof ViewColumnsError) report.push({ view: request.name, created: true })
      throw error
    }
    report.push({ view: request.name, created: true })
    if (request.layout === "roadmap") notes.push(roadmapNote)
  }
  return before
}

export const projectCreate = defineTool({
  id: "github_project_create",
  title: "Create a GitHub project board",
  description: [
    `Create a project board for a user or organization, or reuse the open board of that owner and exact title (case-insensitive; several are invalid_argument), and bring it to the standard template. The title defaults to ${DEFAULT_BOARD_TITLE}. A board that has to be made is empty, or a copy of template without its draft items.`,
    "With standard (the default): the fields Status (Todo, In Progress, Waiting, Done, Cancelled, each with a color and a description), Start and Target (dates), and the views Roadmap, Kanban and Backlog. On a board this call made, Status gets exactly those options, keeping the ids of GitHub's own Todo, In Progress and Done, and GitHub's default view View 1 is deleted once the three views exist. On a reused or copied board only the missing fields, options and views are added, and nothing is deleted. A reused board must be one the viewer may update.",
    "dates: \"issue_fields\" uses the organization's issue fields Start date and Target date as the board's dates, refused before the board is made when the owner is a user or lacks them.",
    "link_repo links the board to a repository (needs write permission there) unless it is already linked. GitHub links only boards of the repository's own owner, so a repository of another owner is invalid_argument, before the board is made.",
    "Once the board exists, a failed step does not fail the call: it is listed in errors and the board is still returned.",
    `notes lists what the API cannot do, such as setting the Roadmap view's date fields. ${PROJECT_SCOPE_NOTE}`,
  ].join(" "),
  toolset: "projects",
  class: "idempotent",
  targets: { owner: "owner", link_repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const ownerArg = givenOwner(args.owner)
    if (ownerArg === undefined) throw invalid(`owner cannot be blank; use a login or ${CURRENT_USER}.`)
    const title = args.title === undefined ? DEFAULT_BOARD_TITLE : given(args.title)
    if (!title) throw invalid("title cannot be blank.")
    const standard = args.standard ?? true
    const templateRef = given(args.template)
    const linkName = given(args.link_repo)
    const login = ownerArg === CURRENT_USER ? await viewerLogin(ctx) : ownerArg
    let linkRepo
    if (linkName) {
      const repo = parseRepo(linkName)
      assertSameOwner({ name: "the board to be created", owner: login }, repo)
      linkRepo = await writableContext(repo, ctx)
    }

    const owner = await readBoardOwner(login, ctx)

    const dateMode = args.dates ?? "board"
    let dateNames: { start: string; target: string } = BOARD_DATE_FIELDS
    let definitions: IssueFieldDefinition[] | null = null
    if (dateMode === "issue_fields") {
      if (!standard) throw invalid("dates applies only with standard.")
      definitions = await readOwnerIssueFields({ owner: owner.login, owner_type: owner.type }, ctx)
      const startDef = requireIssueField({ owner: owner.login, owner_type: owner.type }, definitions, {
        name: ISSUE_DATE_FIELDS.start,
        type: "date",
      })
      const targetDef = requireIssueField({ owner: owner.login, owner_type: owner.type }, definitions, {
        name: ISSUE_DATE_FIELDS.target,
        type: "date",
      })
      dateNames = { start: startDef.name, target: targetDef.name }
    }

    const template = standardTemplate(dateNames)

    const reused = openBoardTitled((await ownerBoards(owner.login, ctx, owner.type)).boards, title)
    if (reused) assertBoardWritable(reused)
    const source =
      reused || !templateRef ? undefined : (await resolveBoard({ project: templateRef, owner: ownerArg }, ctx)).project
    const board =
      reused ?? (source ? await copyBoard(source.id, owner, title, ctx) : await createBoard(owner, title, ctx))
    const created = !reused
    const fresh = created && !source

    // The board exists from here on, so a failing step is reported beside it instead of failing the call.
    const steps = new StepErrors()
    const fields: Created["fields"] = []
    const views: Created["views"] = []
    const notes: string[] = []
    let deletedDefaultView = false
    if (standard) {
      await steps.record("fields", () => applyFields(board, fresh, dateMode, dateNames, definitions, fields, ctx))
      const before = await steps.record("views", () =>
        applyViews(board, template.views, template.roadmapNote, views, notes, ctx),
      )
      const defaultView = fresh ? before?.find((view) => view.name === DEFAULT_VIEW_NAME) : undefined
      if (defaultView) {
        deletedDefaultView =
          (await steps.record("default_view", async () => {
            await deleteView(defaultView.id, ctx)
            return true
          })) ?? false
      }
    }
    const linked = linkRepo
      ? await steps.record("link", async () => {
          if (created || !(await isLinked(board, linkRepo.repo, ctx))) await setLinked(board, linkRepo.id, true, ctx)
          return linkRepo.repo.full
        })
      : undefined

    return {
      project: boardSummary(board),
      created,
      copied_from: source ? boardResource(source) : null,
      fields,
      views,
      deleted_default_view: deletedDefaultView,
      linked: linked ?? null,
      notes,
      errors: steps.errors,
    }
  },
})
