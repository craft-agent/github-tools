import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "../errors"
import { gh } from "../gh"
import { planFieldValues } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { addContentToBoard } from "../github/board-item-write"
import {
  ISSUE_FIELDS_ARGUMENT,
  issueFieldInputSchema,
  issueFieldValuesSchema,
  planIssueFieldWrites,
  readIssueFieldDefinitions,
  readIssueFieldValuesById,
  writeIssueFields,
  type IssueFieldWrite,
} from "../github/issue-fields"
import { ghIssueRef, issueLabel, resolveRelatedIssue, type IssueRef } from "../github/issue-refs"
import { readBlockedBy, readIssueFields } from "../github/issues"
import { kindPlacementSchema, resolveKind } from "../github/kind"
import { milestoneSchema, resolveMilestone, type MilestoneRef } from "../github/milestones"
import { assertBoardWritable, resolveBoard } from "../github/projects"
import {
  applyFieldWrites,
  defaultStatusWrite,
  fieldValuesSchema,
  fieldsResultSchema,
  hasWaitingOption,
  statusToDefault,
} from "../projects/item-support"
import { BOARD_LOOKUP_NOTE, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "../projects/support"
import { resolveRepo, type RepoName } from "../refs"
import { StepErrors, defineTool, type ToolContext } from "../tool"
import { editIssue, setKind } from "./write-support"
import { given, invalid, lastUrl, nameList, writableContext } from "../write-support"

const ISSUE_URL = /\/issues\/(\d+)$/

const input = z.object({
  title: z.string().describe("The issue's title."),
  body: z.string().optional().describe("Markdown body; empty when left out."),
  repo: z.string().optional().describe("owner/name; defaults to the working tree's repository (its origin)."),
  kind: z
    .string()
    .optional()
    .describe("Such as bug or feature: the organization's Issue Type of that name, else the type:<kind> label."),
  labels: z.array(z.string()).optional().describe("Labels to add; they must exist."),
  assignees: z.array(z.string()).optional().describe('Logins, or "@me".'),
  milestone: z.string().optional().describe("A milestone title."),
  create_milestone: z.boolean().optional().describe("Create the milestone when it does not exist; needs milestone."),
  parent: z.string().optional().describe("The parent issue: 12, #12, owner/repo#12 or its URL."),
  blocked_by: z.array(z.string()).optional().describe("Issues that block this one, in the same forms as parent."),
  issue_fields: issueFieldInputSchema.optional().describe(ISSUE_FIELDS_ARGUMENT),
  project: z
    .string()
    .optional()
    .describe(
      "A board to put the issue on: its number, owner/number or its URL, or its title; none by default. The issue starts as Todo on the board when it has that Status option, or Waiting when it is blocked by an open issue and the board has that option.",
    ),
  fields: fieldValuesSchema
    .optional()
    .describe(
      'Board field values to set, by field name: {"Target": "2026-12-01"}; needs project. A Status given here replaces the default. The issue\'s organization fields go in issue_fields.',
    ),
})

const output = z.object({
  repo: z.string(),
  issue: z.object({ number: z.number().int(), url: z.string(), title: z.string() }),
  kind: kindPlacementSchema.nullable().describe("Where the kind landed; null when none was given or its step failed."),
  milestone: milestoneSchema.nullable(),
  relations: z.object({
    parent: z.string().nullable().describe("owner/repo#N of the parent that was set."),
    blocked_by: z.array(z.string()).describe("owner/repo#N of each blocker that was set."),
  }),
  issue_fields: issueFieldValuesSchema
    .nullable()
    .describe(
      "The new issue's field values, by field name; null when issue_fields was not given, its step failed, or the values could not be read back.",
    ),
  project: boardSummarySchema
    .extend({
      item_id: z.string().describe("The project item's node ID (PVTI_…)."),
      fields: fieldsResultSchema,
    })
    .nullable()
    .describe("The board item; null when no project was given or its step failed."),
  foreign: z.boolean(),
  errors: z
    .record(z.string(), z.string())
    .describe(
      "Failed steps (kind, parent, blocked_by, issue_fields, project, fields.<Name>), keyed by step; {} when none.",
    ),
})

/** Where the issue goes in the result: its number and URL, from what `gh issue create` printed. */
function createdIssue(stdout: string): { number: number; url: string } {
  const url = lastUrl(stdout)
  const number = url && ISSUE_URL.exec(url)?.[1]
  if (!url || !number) {
    throw new ToolError(
      "github_error",
      `gh printed no issue URL, so the new issue's number is unknown; it may exist, so look in the repository before creating it again. Output: ${stdout.trim()}`,
    )
  }
  return { number: Number.parseInt(number, 10), url }
}

/** One call per blocker, so each that GitHub accepts is kept; the failures are reported together. */
async function addBlockers(
  target: RepoName,
  number: number,
  blockers: IssueRef[],
  done: string[],
  ctx: ToolContext,
): Promise<void> {
  const failures: string[] = []
  for (const blocker of blockers) {
    try {
      await editIssue(target, number, ["--add-blocked-by", ghIssueRef(blocker, target)], ctx)
      done.push(issueLabel(blocker))
    } catch (error) {
      if (isAbortError(error)) throw error
      failures.push(`${issueLabel(blocker)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new ToolError("github_error", failures.join("; "))
}

export const issueCreate = defineTool({
  id: "github_issue_create",
  title: "Create a GitHub issue",
  intent: "About to create a GitHub issue",
  description: [
    "Create an issue in a repository the viewer may write to, and settle its place in the same call: kind (an Issue Type, else a type:<kind> label that is created when missing), labels, assignees (they are notified), milestone, parent and blocked-by issues, organization issue fields, and a project board with field values (the Status starts as Todo, or Waiting when an open issue blocks it).",
    "Everything that can fail is checked before the issue is made: the milestone exists (unless create_milestone is true), the issue fields, their options and values exist (a repository without issue fields refuses them), and the board accepts the values.",
    "Once the issue exists, a failed kind, parent, blocked_by, issue_fields, project or fields.<Name> step does not fail the call: it is listed in errors and the issue is still returned.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the new issue's repository.",
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "issues",
  class: "add",
  targets: { repo: "repo", parent: "issue", blocked_by: "issues", project: "optional_board" },
  input,
  output,
  async execute(args, ctx) {
    const title = given(args.title)
    if (!title) throw invalid("title cannot be blank.")
    const [kind] = nameList("kind", args.kind === undefined ? [] : [args.kind])
    const labels = nameList("labels", args.labels)
    const assignees = nameList("assignees", args.assignees)
    const milestoneTitle = given(args.milestone)
    if (args.create_milestone && !milestoneTitle) throw invalid("create_milestone needs milestone.")
    if (args.fields !== undefined && args.project === undefined) {
      throw invalid("fields are board field values and need project; pass the board, or leave fields out.")
    }

    const requested = await resolveRepo(args.repo, ctx)
    const parentRef = given(args.parent)
    const parent = parentRef ? await resolveRelatedIssue(parentRef, requested, ctx) : undefined
    const blockers: IssueRef[] = []
    for (const ref of args.blocked_by ?? []) {
      const blocker = given(ref)
      if (blocker) blockers.push(await resolveRelatedIssue(blocker, requested, ctx))
    }

    const context = await writableContext(requested, ctx)
    const target = context.repo
    let fieldWrites: IssueFieldWrite[] | undefined
    if (args.issue_fields && Object.keys(args.issue_fields).length > 0) {
      if (Object.keys(args.issue_fields).some((name) => !name.trim())) {
        throw invalid("issue_fields has a blank field name; pass the field's name.")
      }
      fieldWrites = planIssueFieldWrites(target, await readIssueFieldDefinitions(target, ctx), args.issue_fields, [])
    }
    const board =
      args.project === undefined
        ? undefined
        : (await resolveBoard({ project: args.project, repo: args.repo }, ctx)).project
    if (board) assertBoardWritable(board)
    const boardFields = board ? await readBoardFields(board.id, ctx) : []
    const fieldValues = args.fields ?? {}
    const writes = board ? planFieldValues(boardFields, fieldValues) : []
    const status = board ? statusToDefault(boardFields, fieldValues) : undefined

    const milestone: MilestoneRef | null = milestoneTitle
      ? await resolveMilestone(target, milestoneTitle, { create: Boolean(args.create_milestone) }, ctx)
      : null

    const flags = ["--title", title, "--body-file", "-"]
    for (const label of labels) flags.push("--label", label)
    for (const assignee of assignees) flags.push("--assignee", assignee)
    if (milestone) flags.push("--milestone", milestone.title)
    const stdout = await gh(["issue", "create", "--repo", target.full, ...flags], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      stdin: args.body ?? "",
    })
    const created = createdIssue(stdout)

    // The issue exists from here on, so a failing step is reported beside it instead of failing the call.
    const steps = new StepErrors()
    const kindPlacement = kind
      ? await steps.record("kind", async () =>
          setKind(kind, await resolveKind(kind, target, ctx), target, created.number, ctx),
        )
      : undefined
    const parentSet = parent
      ? await steps.record("parent", async () => {
          await editIssue(target, created.number, ["--parent", ghIssueRef(parent, target)], ctx)
          return issueLabel(parent)
        })
      : undefined
    const blockedBy: string[] = []
    if (blockers.length)
      await steps.record("blocked_by", () => addBlockers(target, created.number, blockers, blockedBy, ctx))

    let issueNodeId: string | undefined
    const readId = async (): Promise<string> => {
      if (issueNodeId) return issueNodeId
      const { id } = await readIssueFields({ repo: target, number: created.number }, ctx)
      issueNodeId = id
      return id
    }

    const issueFields = fieldWrites
      ? await steps.record("issue_fields", async () => {
          const id = await readId()
          await writeIssueFields(id, fieldWrites, ctx)
          return readIssueFieldValuesById(id, ctx).catch((error: unknown) => {
            if (!isToolError(error)) throw error
            return null
          })
        })
      : null

    if (board && status) {
      const waiting =
        hasWaitingOption(status) && blockedBy.length > 0
          ? await steps.record("blocked_by", async () =>
              (await readBlockedBy({ repo: target, number: created.number }, ctx)).some(
                (blocker) => blocker.state === "open",
              ),
            )
          : false
      writes.push(...defaultStatusWrite(boardFields, status, Boolean(waiting)))
    }

    const placed = board
      ? await steps.record("project", async () => {
          const id = await readId()
          return { itemId: await addContentToBoard(board.id, id, ctx) }
        })
      : undefined
    const set = board && placed ? await applyFieldWrites(board.id, placed.itemId, writes, steps, ctx) : {}

    return {
      repo: target.full,
      issue: { number: created.number, url: created.url, title },
      kind: kindPlacement ?? null,
      milestone,
      relations: { parent: parentSet ?? null, blocked_by: blockedBy },
      issue_fields: issueFields ?? null,
      project: board && placed ? { ...boardSummary(board), item_id: placed.itemId, fields: set } : null,
      foreign: context.foreign,
      errors: steps.errors,
    }
  },
})
