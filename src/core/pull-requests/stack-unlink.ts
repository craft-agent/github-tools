import { z } from "zod"
import { readStack, stackOfPull, stackSchema, unstack } from "../github/stacks"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { parseNumberRef, resolveRepo } from "../refs"
import { given } from "../search"
import { defineTool } from "../tool"
import { PR_DESCRIPTION } from "./write-support"

const input = z.object({
  stack: z.number().int().min(1).optional().describe("The stack's number (not a pull request's)."),
  pr: z.string().optional().describe(`A pull request in the stack. ${PR_DESCRIPTION}`),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
})

const output = z.object({
  repo: z.string(),
  stack_number: z
    .number()
    .int()
    .nullable()
    .describe("The stack that was taken apart; null when the pull request was in none."),
  removed: z.array(z.number().int()).describe("The pull requests that left the stack."),
  remaining: stackSchema
    .nullable()
    .describe("What is left of the stack (merged and queued pull requests stay); null when it is gone."),
  changed: z
    .boolean()
    .describe("False when the pull request was in no stack, or none of the stack's pull requests could leave."),
  foreign: z.boolean(),
})

export const stackUnlink = defineTool({
  id: "github_stack_unlink",
  title: "Take GitHub pull requests out of a stack",
  intent: "About to take GitHub pull requests out of a stack",
  description: [
    "Take the pull requests out of a native stack, named by its number or by a pull request in it. Every unmerged pull request leaves (open, draft and closed ones); merged and queued ones stay in the stack, and remaining shows what is left, null when the stack is gone.",
    "The pull requests stay open with their branches and bases as they were, and nothing is deleted: github_stack_link can build the stack again.",
    "A pull request in no stack is left alone: nothing is sent and changed is false. A pull request is 12, #12, owner/repo#12 or its URL.",
  ].join(" "),
  toolset: "pull_requests",
  class: "overwrite",
  targets: { pr: "pull", repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const pr = given(args.pr)
    if ((args.stack === undefined) === (pr === undefined)) {
      throw invalid("Give exactly one of `stack` (a stack number) or `pr` (a pull request in the stack).")
    }
    const named = pr === undefined ? undefined : await parseNumberRef(pr, args.repo, ctx, { accept: "pull" })
    const context = await writableContext(named?.repo ?? (await resolveRepo(args.repo, ctx)), ctx)
    const repo = context.repo
    const result = { repo: repo.full, foreign: context.foreign }

    const number = named ? await stackOfPull(repo, named.number, ctx) : args.stack!
    if (number === null) return { ...result, stack_number: null, removed: [], remaining: null, changed: false }

    const before = (await readStack(repo, number, ctx)).layers.map((layer) => layer.number)
    const remaining = await unstack(repo, number, ctx)
    const kept = new Set(remaining?.layers.map((layer) => layer.number))
    const removed = before.filter((member) => !kept.has(member))
    return { ...result, stack_number: number, removed, remaining, changed: removed.length > 0 }
  },
})
