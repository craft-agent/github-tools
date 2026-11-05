import { z } from "zod"
import { ToolError } from "../errors"
import { gh, ghJson } from "../gh"
import { planFieldValues } from "../github/board-field-values"
import { readBoardFields } from "../github/board-fields"
import { addContentToBoard } from "../github/board-item-write"
import { branchHead, defaultBranch } from "../github/branches"
import { milestoneSchema, resolveMilestone, type MilestoneRef } from "../github/milestones"
import { closingIssueSchema, readPullRequestState, type PullRequestState } from "../github/pull-requests"
import { assertBoardWritable, resolveBoard } from "../github/projects"
import { REPO_DESCRIPTION, given, invalid, lastUrl, nameList, writableContext } from "../issues/write-support"
import {
  FIELDS_NOTE,
  applyFieldWrites,
  defaultStatusWrite,
  fieldValuesSchema,
  fieldsResultSchema,
  statusToDefault,
  stepErrorsSchema,
} from "../projects/item-support"
import { BOARD_LOOKUP_NOTE, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "../projects/support"
import { resolveRepo } from "../refs"
import { StepErrors, defineTool } from "../tool"
import { CLOSES_DESCRIPTION, withClosing } from "./closes"
import { closingNotes, resolveClosing, settledClosingState, type ClosingChange } from "./write-support"

const PULL_URL = /\/pull\/(\d+)$/
const SHA_PATTERN = /^[0-9a-f]{40}$/i
const SHORT_SHA_LENGTH = 12
const NOT_A_BRANCH = "head must be a branch of the repository; pull requests from forks are not supported yet."

const input = z.object({
  head: z.string().describe("The branch of the repository to merge from; it must be pushed already."),
  base: z.string().optional().describe("The branch of the repository to merge into; defaults to its default branch."),
  title: z.string().describe("The pull request's title."),
  body: z.string().optional().describe("Markdown body; empty when left out."),
  draft: z.boolean().optional().describe("Open it as a draft (default false)."),
  head_sha: z
    .string()
    .optional()
    .describe(
      "The commit the head branch must be at (40 hex characters): the call fails with stale, creating nothing, when the branch moved.",
    ),
  repo: z.string().optional().describe("owner/name; defaults to the working tree's repository (its origin)."),
  labels: z.array(z.string()).optional().describe("Labels to add; they must exist."),
  assignees: z.array(z.string()).optional().describe('Logins, or "@me".'),
  reviewers: z
    .array(z.string())
    .optional()
    .describe("Logins, or org/team, to request a review from; they are notified."),
  milestone: z.string().optional().describe("A milestone title; it must exist."),
  closes: z.array(z.string()).optional().describe(CLOSES_DESCRIPTION.closes),
  project: z
    .string()
    .optional()
    .describe(
      "A board to put the pull request on: its number, owner/number or its URL, or its title; none by default. The pull request starts as Todo on the board when it has that Status option.",
    ),
  fields: fieldValuesSchema
    .optional()
    .describe(
      'Board field values to set, by field name: {"Target": "2026-12-01"}; needs project. A Status given here replaces the Todo default.',
    ),
})

const output = z.object({
  repo: z.string(),
  pr: z.object({ number: z.number().int(), url: z.string(), title: z.string() }),
  base: z.string(),
  head: z.string(),
  head_sha: z.string().describe("The commit the head branch is at, as read after the pull request was created."),
  draft: z.boolean(),
  closing_issues: z
    .array(closingIssueSchema)
    .describe("The issues GitHub links as closed by the pull request; [] when none or when it could not be read."),
  project: boardSummarySchema
    .extend({
      item_id: z.string().describe("The project item's node ID (PVTI_…)."),
      fields: fieldsResultSchema,
    })
    .nullable()
    .describe("The board item; null when no project was given or its step failed."),
  notes: z.array(z.string()).describe("What to know about the result; [] when nothing."),
  foreign: z.boolean(),
  errors: stepErrorsSchema,
})

const short = (sha: string): string => sha.slice(0, SHORT_SHA_LENGTH)

/** Where the pull request goes in the result: its number, from the URL `gh pr create` printed. */
function createdPullRequest(stdout: string): { number: number; url: string } {
  const url = lastUrl(stdout)
  const number = url && PULL_URL.exec(url)?.[1]
  if (!url || !number) {
    throw new ToolError(
      "github_error",
      "GitHub did not print the pull request it created; look for it before running this again.",
    )
  }
  return { number: Number.parseInt(number, 10), url }
}

export const prCreate = defineTool({
  id: "github_pr_create",
  title: "Create a GitHub pull request",
  description: [
    "Open a pull request from a pushed branch of a repository the viewer may write to into another branch of it (default: the default branch), and settle its place in the same call: draft, labels, assignees and reviewers (they are notified), milestone, the issues it closes (a `Closes #12` line at the end of the body) and a project board with field values (the Status starts as Todo). Pull requests from forks are not supported yet.",
    "Everything that can fail is checked before the pull request is made: the branches exist, head_sha (when given) is still the head, no pull request is open from head into base already, the milestone exists and the board accepts the values.",
    "Once the pull request exists, a failed read-back, board or field step does not fail the call: it is listed in errors and the pull request is still returned.",
    "GitHub links closing issues only for a pull request into the default branch, and a moment after it exists: the call waits up to a few seconds for the link, and notes say when this pull request is not into the default branch or an issue was not linked yet.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number in closes means the pull request's repository.",
    BOARD_LOOKUP_NOTE,
    FIELDS_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "pull_requests",
  class: "add",
  targets: { repo: "repo", project: "optional_board" },
  input,
  output,
  async execute(args, ctx) {
    const title = given(args.title)
    if (!title) throw invalid("title cannot be blank.")
    const head = given(args.head)
    if (!head) throw invalid("head cannot be blank.")
    if (head.includes(":")) throw invalid(NOT_A_BRANCH)
    const explicitBase = given(args.base)
    if (args.base !== undefined && !explicitBase) throw invalid("base is blank; pass a branch, or leave it out.")
    if (explicitBase === head) throw invalid(`head and base are both ${head}; pass two different branches.`)
    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }
    const milestoneTitle = given(args.milestone)
    if (args.milestone !== undefined && !milestoneTitle)
      throw invalid("milestone is blank; pass its title, or leave it out.")
    if (args.fields !== undefined && args.project === undefined) {
      throw invalid("fields are board field values and need project; pass the board, or leave fields out.")
    }
    const labels = nameList("labels", args.labels)
    const assignees = nameList("assignees", args.assignees)
    const reviewers = nameList("reviewers", args.reviewers)

    const requested = await resolveRepo(args.repo, ctx)
    const closes = await resolveClosing(args.closes, requested, ctx)

    const context = await writableContext(requested, ctx)
    const target = context.repo
    // The default branch is the base when none is given, and what the note on closing issues compares it with.
    const fallback = explicitBase === undefined || closes.length > 0 ? await defaultBranch(target, ctx) : null
    const base = explicitBase ?? fallback
    if (!base) {
      throw invalid(`${target.full} has no default branch (it is empty); push a branch to it first, or pass base.`)
    }
    if (base === head) throw invalid(`head and base are both ${head}; pass two different branches.`)

    if ((await branchHead(target, base, ctx)) === null) throw invalid(`base branch "${base}" is not on ${target.full}.`)
    const headSha = await branchHead(target, head, ctx)
    if (headSha === null) throw invalid(`head branch "${head}" is not on ${target.full}; push it first.`)
    if (expectedSha && headSha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${head} on ${target.full} is at ${short(headSha)}, not ${short(expectedSha)}: the branch moved since it was pushed. Nothing was created.`,
      )
    }

    const open = await ghJson<{ number: number; url: string }[]>(
      [
        "pr",
        "list",
        "--repo",
        target.full,
        "--head",
        head,
        "--base",
        base,
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ],
      ctx,
    )
    const existing = open?.[0]
    if (existing) {
      throw invalid(
        `${target.full}#${existing.number} is already open from ${head} into ${base}: ${existing.url}. Change it with github_pr_edit.`,
      )
    }

    const milestone: MilestoneRef | null = milestoneTitle
      ? await resolveMilestone(target, milestoneTitle, { create: false, creatable: false }, ctx)
      : null
    const board =
      args.project === undefined
        ? undefined
        : (await resolveBoard({ project: args.project, repo: args.repo }, ctx)).project
    if (board) assertBoardWritable(board)
    const boardFields = board ? await readBoardFields(board.id, ctx) : []
    const fieldValues = args.fields ?? {}
    const writes = board ? planFieldValues(boardFields, fieldValues) : []
    const status = board ? statusToDefault(boardFields, fieldValues) : undefined
    // A pull request never starts as Waiting: that is for an issue with an open blocker.
    if (status) writes.push(...defaultStatusWrite(boardFields, status, false))

    const flags = ["--base", base, "--head", head, "--title", title, "--body-file", "-"]
    if (args.draft) flags.push("--draft")
    for (const label of labels) flags.push("--label", label)
    for (const assignee of assignees) flags.push("--assignee", assignee)
    for (const reviewer of reviewers) flags.push("--reviewer", reviewer)
    if (milestone) flags.push("--milestone", milestone.title)
    const body = closes.length > 0 ? withClosing(args.body ?? "", closes, [], target) : (args.body ?? "")
    const stdout = await gh(["pr", "create", "--repo", target.full, ...flags], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      stdin: body,
    })
    const created = createdPullRequest(stdout)

    // The pull request exists from here on, so a failing step is reported beside it instead of failing the call.
    const steps = new StepErrors()
    const pull = { repo: target, number: created.number }
    const read: PullRequestState | undefined = await steps.record("read", () => readPullRequestState(pull, ctx))
    if (read && expectedSha && read.head_sha.toLowerCase() !== expectedSha.toLowerCase()) {
      await steps.record("head_sha", async () => {
        throw new Error(`the head moved to ${read.head_sha} while the pull request was created`)
      })
    }

    const placed = board
      ? await steps.record("project", async () => {
          if (!read) {
            throw new ToolError(
              "github_error",
              `the pull request could not be read back, so it was not put on the board; add it with github_project_item_add (${target.full}#${created.number}).`,
            )
          }
          return { itemId: await addContentToBoard(board.id, read.id, ctx) }
        })
      : undefined
    const set = board && placed ? await applyFieldWrites(board.id, placed.itemId, writes, steps, ctx) : {}

    // GitHub links the closing issues a moment after the pull request exists, so they are read again until they are.
    const closing: ClosingChange = { add: closes, remove: [] }
    const settled =
      read && closes.length > 0
        ? await settledClosingState(read, closing, { pull, defaultBranch: fallback }, ctx)
        : read

    return {
      repo: target.full,
      pr: { number: created.number, url: created.url, title },
      base,
      head,
      head_sha: read?.head_sha ?? headSha,
      draft: read?.draft ?? Boolean(args.draft),
      closing_issues: settled?.closing_issues ?? [],
      project: board && placed ? { ...boardSummary(board), item_id: placed.itemId, fields: set } : null,
      notes: closingNotes({ ...closing, base, defaultBranch: fallback, linked: settled?.closing_issues }),
      foreign: context.foreign,
      errors: steps.errors,
    }
  },
})
