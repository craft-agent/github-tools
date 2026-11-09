import { z } from "zod"
import {
  addToStack,
  createStack,
  readPullForStack,
  readStack,
  stackSchema,
  type Stack,
  type StackPull,
} from "../github/stacks"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo, type RepoName } from "../refs"
import { defineTool, type ToolContext } from "../tool"

const MIN_NEW_STACK = 2
const MAX_PULL_REQUESTS = 100

const input = z.object({
  prs: z
    .array(z.number().int().min(1))
    .min(1)
    .max(MAX_PULL_REQUESTS)
    .describe(
      `The pull request numbers of the repository, bottom to top; at least ${MIN_NEW_STACK} unless some are in a stack already, and at most ${MAX_PULL_REQUESTS}. Each one's base branch is the head branch of the one before it.`,
    ),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
})

const output = z.object({
  repo: z.string(),
  stack: stackSchema.describe("The stack as GitHub holds it after the call, its pull requests bottom to top."),
  changed: z.boolean().describe("False when the pull requests were in the stack already and nothing was sent."),
  created: z.boolean().describe("Whether this call made the stack."),
  added: z.array(z.number().int()).describe("The pull requests this call put into the stack, bottom to top."),
  foreign: z.boolean(),
})

const numbersOf = (numbers: readonly number[]): string => numbers.map((number) => `#${number}`).join(", ")

/** Refuses a pull request that is not open, or whose head branch is not in `repo`: GitHub stacks only open pull requests of one repository. */
function refuseUnstackable(pulls: readonly StackPull[], repo: RepoName): void {
  for (const pull of pulls) {
    if (pull.state !== "open") {
      throw invalid(`${repo.full}#${pull.number} is ${pull.state}; only open pull requests can be linked into a stack.`)
    }
    if (pull.head_repo?.toLowerCase() !== repo.full.toLowerCase()) {
      throw invalid(
        `#${pull.number}'s head branch is in ${pull.head_repo ?? "a fork that no longer exists"}, not ${repo.full}: stacks join pull requests of one repository.`,
      )
    }
  }
}

/** Refuses pull requests whose bases do not chain, each onto the head of the one below. */
function refuseBrokenChain(pulls: readonly StackPull[]): void {
  for (const [index, pull] of pulls.entries()) {
    const below = pulls[index - 1]
    if (below && pull.base !== below.head) {
      throw invalid(
        `#${pull.number}'s base is ${pull.base}, not ${below.head} (the head of #${below.number} below it); change it with github_pr_edit base, then link again.`,
      )
    }
  }
}

/** The number of the one stack the pull requests are in, `null` when they are in none; two different stacks are refused. */
function stackAmong(pulls: readonly StackPull[]): number | null {
  const first = pulls.find((pull) => pull.stack !== null)
  if (!first) return null
  const other = pulls.find((pull) => pull.stack !== null && pull.stack !== first.stack)
  if (other) {
    throw invalid(
      `#${first.number} is in stack #${first.stack} but #${other.number} is in stack #${other.stack}; one chain cannot join two stacks. github_stack_unlink dissolves a stack (its pull requests stay open), then link the chain again.`,
    )
  }
  return first.stack
}

/**
 * The pull requests to put on top of `stack`: the numbers after the run at the
 * start of `pulls` that is the top of the stack (its top alone, a tail of it, or
 * all of it). Any other arrangement is refused.
 */
function newOnTop(pulls: readonly StackPull[], stack: Stack): number[] {
  const numbers = pulls.map((pull) => pull.number)
  const members = stack.layers.map((layer) => layer.number)
  let run = 0
  while (run < pulls.length && pulls[run]!.stack === stack.number) run++
  const isTop = run > 0 && numbers.slice(0, run).every((number, i) => number === members[members.length - run + i])
  const rest = pulls.slice(run)
  if (!isTop || rest.some((pull) => pull.stack !== null)) {
    throw invalid(
      `New pull requests go on top of #${members.at(-1)}: list a run of stack #${stack.number} that ends at #${members.at(-1)} (that one alone, or more of it, up to the whole stack), then the new ones in order. Stack #${stack.number} is, bottom to top: ${numbersOf(members)}.`,
    )
  }
  return rest.map((pull) => pull.number)
}

/** Reads the pull requests together; the error thrown is that of the first one in `numbers` that failed. */
async function readPulls(repo: RepoName, numbers: readonly number[], ctx: ToolContext): Promise<StackPull[]> {
  const results = await Promise.allSettled(numbers.map((number) => readPullForStack(repo, number, ctx)))
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason
    return result.value
  })
}

export const stackLink = defineTool({
  id: "github_stack_link",
  title: "Link GitHub pull requests into a stack",
  intent: "About to link GitHub pull requests into a stack",
  description: [
    "Make a native stack of open pull requests of one repository, listed bottom to top, or put more of them on top of an existing stack. Each pull request's base branch must be the head branch of the one below it.",
    "It never changes a base or opens a pull request: github_pr_create and github_pr_edit do that, and a chain whose bases do not match is refused with the base to fix.",
    "An existing stack only grows on top: list its top pull request (or a longer run of its top, up to all of it) and then the new ones.",
    "It is idempotent: pull requests that are in the stack already change nothing and changed is false.",
  ].join(" "),
  toolset: "pull_requests",
  class: "idempotent",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const numbers = args.prs
    const repeated = numbers.find((number, index) => numbers.indexOf(number) !== index)
    if (repeated !== undefined) throw invalid(`#${repeated} is listed twice; list each pull request once.`)

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const pulls = await readPulls(repo, numbers, ctx)
    refuseUnstackable(pulls, repo)
    refuseBrokenChain(pulls)

    const result = { repo: repo.full, foreign: context.foreign }
    const stackNumber = stackAmong(pulls)
    if (stackNumber === null) {
      if (numbers.length < MIN_NEW_STACK) {
        throw invalid(
          `A stack needs at least ${MIN_NEW_STACK} pull requests; list the ones to join with #${numbers[0]}.`,
        )
      }
      return { ...result, stack: await createStack(repo, numbers, ctx), changed: true, created: true, added: numbers }
    }

    const existing = await readStack(repo, stackNumber, ctx)
    const added = newOnTop(pulls, existing)
    if (added.length === 0) return { ...result, stack: existing, changed: false, created: false, added }
    return { ...result, stack: await addToStack(repo, stackNumber, added, ctx), changed: true, created: false, added }
  },
})
