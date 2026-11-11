import { z } from "zod"
import { convertDraftToIssue } from "../github/board-item-write"
import { kindPlacementSchema, resolveKind } from "../github/kind"
import { milestoneSchema, resolveMilestone } from "../github/milestones"
import { assertBoardWritable, given } from "../github/projects"
import { editIssue, milestoneFact, setKind } from "../issues/write-support"
import { invalid, nameList, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { githubTargets } from "../github/targets"
import { StepErrors, defineTool, type CallFact } from "../tool"
import { changeFact } from "../write-facts"
import { describedItem } from "./describe-support"
import { resolveBoardItem } from "./item-resolve"
import { ITEM_NOTE, contentNoun, itemArgument, stepErrorsSchema } from "./item-support"
import { BOARD_LOOKUP_NOTE, BOARD_SELECTION, PROJECT_SCOPE_NOTE, boardSummary, boardSummarySchema } from "./support"

const input = z.object({
  item: itemArgument.describe("The draft item's node ID (PVTI_…); only a draft can be turned into an issue."),
  ...BOARD_SELECTION,
  repo: z
    .string()
    .optional()
    .describe(
      "owner/name of the repository the issue is created in; defaults to the working tree's repository (its origin). Also where the board lookup starts.",
    ),
  kind: z
    .string()
    .optional()
    .describe("Such as bug or feature: the organization's Issue Type of that name, else the type:<kind> label."),
  labels: z.array(z.string()).optional().describe("Labels to add; they must exist."),
  milestone: z.string().optional().describe("A milestone title."),
  create_milestone: z.boolean().optional().describe("Create the milestone when it does not exist; needs milestone."),
})

const output = z.object({
  project: boardSummarySchema,
  item_id: z.string(),
  issue: z.object({ number: z.number().int(), url: z.string() }),
  repo: z.string().describe("owner/name of the repository the issue was created in."),
  kind: kindPlacementSchema.nullable().describe("Where the kind landed; null when none was given or its step failed."),
  milestone: milestoneSchema
    .nullable()
    .describe("The milestone the call settled on; if errors.milestone is set it was not applied to the issue."),
  foreign: z.boolean(),
  errors: stepErrorsSchema,
})

export const projectItemConvert = defineTool({
  id: "github_project_item_convert",
  title: "Convert a GitHub project draft into an issue",
  intent: "About to convert a GitHub project draft into an issue",
  description: [
    "Turn a draft item into an issue of a repository the viewer may write to: the draft's title and body become the issue, and the item stays on the board with its field values. The viewer must also be able to update the board; both are checked before anything is written. An item that is not a draft is invalid_argument.",
    "Then settle the issue as github_issue_create does: kind (an Issue Type, else a type:<kind> label that is created when missing), labels and milestone. A milestone that does not exist fails before the draft is converted unless create_milestone is true.",
    "Once the issue exists, a failed kind, labels or milestone step does not fail the call: it is listed in errors and the issue is still returned.",
    ITEM_NOTE,
    BOARD_LOOKUP_NOTE,
    PROJECT_SCOPE_NOTE,
  ].join(" "),
  toolset: "projects",
  class: "add",
  targets: githubTargets({ item: "item", repo: "repo" }),
  async describe(args, ctx) {
    const [kind] = nameList("kind", args.kind === undefined ? [] : [args.kind])
    const labels = nameList("labels", args.labels)
    const milestoneTitle = given(args.milestone)
    if (args.create_milestone && !milestoneTitle) throw invalid("create_milestone needs milestone.")

    const { board, item } = await describedItem(args, ctx)
    assertBoardWritable(board)
    if (item.content?.type !== "draft") {
      throw invalid(
        `Only a draft can be converted into an issue, but item ${item.item_id} is ${contentNoun(item.content)}.`,
      )
    }

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const facts: CallFact[] = []
    if (kind) facts.push({ label: "Kind", value: kind })
    const labelsFact = changeFact("Labels", labels)
    if (labelsFact) facts.push(labelsFact)
    if (milestoneTitle)
      facts.push(await milestoneFact(context.repo, milestoneTitle, Boolean(args.create_milestone), ctx))

    const body = item.content.body ?? ""
    return {
      headline: { text: "About to turn the draft {title} into an issue", values: { title: item.content.title } },
      facts,
      ...(body ? { text: { label: "Issue body", body } } : {}),
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const [kind] = nameList("kind", args.kind === undefined ? [] : [args.kind])
    const labels = nameList("labels", args.labels)
    const milestoneTitle = given(args.milestone)
    if (args.create_milestone && !milestoneTitle) throw invalid("create_milestone needs milestone.")

    const { board, item } = await resolveBoardItem(args, ctx)
    assertBoardWritable(board)
    if (item.content?.type !== "draft") {
      throw invalid(
        `Only a draft can be converted into an issue, but item ${item.item_id} is ${contentNoun(item.content)}.`,
      )
    }

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const target = context.repo
    const milestone = milestoneTitle
      ? await resolveMilestone(target, milestoneTitle, { create: Boolean(args.create_milestone) }, ctx)
      : null

    const issue = await convertDraftToIssue(item.item_id, context.id, ctx)

    // The issue exists from here on, so a failing step is reported beside it instead of failing the call.
    const steps = new StepErrors()
    const placement = kind
      ? await steps.record("kind", async () =>
          setKind(kind, await resolveKind(kind, target, ctx), target, issue.number, ctx),
        )
      : undefined
    if (labels.length) {
      await steps.record("labels", () =>
        editIssue(
          target,
          issue.number,
          labels.flatMap((label) => ["--add-label", label]),
          ctx,
        ),
      )
    }
    if (milestone)
      await steps.record("milestone", () => editIssue(target, issue.number, ["--milestone", milestone.title], ctx))

    return {
      project: boardSummary(board),
      item_id: item.item_id,
      issue,
      repo: target.full,
      kind: placement ?? null,
      milestone,
      foreign: context.foreign,
      errors: steps.errors,
    }
  },
})
