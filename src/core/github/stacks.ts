import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { pullRequestNotFound } from "./pull-requests"

/** Native stacks of pull requests over GitHub's REST API, which serves them under a dated API version. */

/** The API version every stack call sends; the stack endpoints exist only under it. */
export const STACK_API_VERSION = "2026-03-10"

const VERSION_HEADER = ["-H", `X-GitHub-Api-Version: ${STACK_API_VERSION}`]
const STACKS_PAGE_SIZE = 100
const MAX_STACK_PAGES = 10
const CONFLICT_FAILURE = /http 409/i

export const stackLayerSchema = z.object({
  position: z.number().int().describe("1 is the bottom of the stack."),
  number: z.number().int(),
  title: z.string().nullable().describe("Null when GitHub gave only the short form of the stack (a list)."),
  state: z.string().describe("open, closed or merged."),
  draft: z.boolean(),
  head: z.string().describe("The head branch name."),
  head_sha: z.string(),
  base: z.string().nullable().describe("The base branch name; null in the short form."),
  url: z.string().nullable().describe("Null in the short form."),
})

export const stackSchema = z.object({
  number: z.number().int().describe("The stack's number, which is not a pull request's."),
  base: z.string().describe("The branch the bottom pull request merges into."),
  open: z.boolean(),
  size: z.number().int().describe("How many pull requests the stack holds."),
  layers: z.array(stackLayerSchema).describe("The pull requests, bottom to top."),
})

export type StackLayer = z.output<typeof stackLayerSchema>
export type Stack = z.output<typeof stackSchema>
export type PullState = "open" | "closed" | "merged"

/** A pull request as the stack tools need it: its state and branches, and the stack it is in. */
export type StackPull = {
  number: number
  state: PullState
  draft: boolean
  base: string
  head: string
  head_sha: string
  /** `owner/name` of the head repository; `null` for a deleted fork. */
  head_repo: string | null
  /** The number of the stack the pull request is in, `null` when it is in none. */
  stack: number | null
  position: number | null
}

type RawStackPull = {
  number: number
  state: string
  draft?: boolean
  merged_at?: string | null
  head: { ref: string; sha: string }
  title?: string
  html_url?: string
  base?: { ref: string }
}
type RawStack = { number: number; base: { ref: string }; open: boolean; pull_requests: RawStackPull[] }
type RawPull = {
  state: string
  draft?: boolean
  merged_at?: string | null
  base: { ref: string }
  head: { ref: string; sha: string; repo?: { full_name: string } | null }
  stack?: { number: number; position: number } | null
}

function pullState(raw: Pick<RawPull, "state" | "merged_at">): PullState {
  if (raw.merged_at) return "merged"
  return raw.state === "open" ? "open" : "closed"
}

/** A stack from either shape GitHub gives it: the short one of a list, or the full one of a read and a write. */
function mapStack(raw: RawStack): Stack {
  const layers = raw.pull_requests.map((pull, index): StackLayer => ({
    position: index + 1,
    number: pull.number,
    title: pull.title ?? null,
    state: pullState(pull),
    draft: Boolean(pull.draft),
    head: pull.head.ref,
    head_sha: pull.head.sha,
    base: pull.base?.ref ?? null,
    url: pull.html_url ?? null,
  }))
  return { number: raw.number, base: raw.base.ref, open: raw.open, size: layers.length, layers }
}

function stackNotFound(repo: RepoName, number: number, cause: unknown): ToolError {
  return new ToolError("not_found", `Stack #${number} was not found in ${repo.full}.`, { cause })
}

/**
 * A stack call, with GitHub's failures put in terms of the stack: a missing one
 * is `not_found` and a change that collided with another is `stale`, saying to
 * read the stack again. Any other failure passes as it is.
 */
async function stackCall<T>(repo: RepoName, number: number | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!isToolError(error)) throw error
    if (error.code === "not_found" && number !== undefined) throw stackNotFound(repo, number, error)
    if (error.code === "stale" && CONFLICT_FAILURE.test(error.message)) {
      const subject = number === undefined ? "a stack" : `stack #${number}`
      throw new ToolError("stale", `Another change to ${subject} is running; read it again and retry.`, {
        cause: error,
      })
    }
    throw error
  }
}

function request<T>(
  method: "GET" | "POST",
  path: string,
  ctx: RefContext,
  body?: Record<string, unknown>,
): Promise<T | null> {
  return ghJson<T>(
    ["api", ...(method === "POST" ? ["-X", method] : []), ...VERSION_HEADER, path, ...(body ? ["--input", "-"] : [])],
    { cwd: ctx.cwd, signal: ctx.signal, stdin: body && JSON.stringify(body) },
  )
}

function required(stack: Stack | null): Stack {
  if (!stack) throw new ToolError("github_error", "GitHub did not return the stack.")
  return stack
}

async function stackReply(
  repo: RepoName,
  number: number | undefined,
  call: () => Promise<RawStack | null>,
): Promise<Stack | null> {
  const raw = await stackCall(repo, number, call)
  return raw ? mapStack(raw) : null
}

/**
 * The repository's stacks in GitHub's order, at most `limit` (of the open ones
 * only with `openOnly`, since GitHub has no filter for it). `truncated` is true
 * when more matched than were returned, or when the page cap stopped the walk.
 */
export async function listStacks(
  repo: RepoName,
  options: { openOnly: boolean; limit: number },
  ctx: RefContext,
): Promise<{ stacks: Stack[]; truncated: boolean }> {
  const stacks: Stack[] = []
  for (let page = 1; page <= MAX_STACK_PAGES; page++) {
    const raw =
      (await request<RawStack[]>("GET", `repos/${repo.full}/stacks?per_page=${STACKS_PAGE_SIZE}&page=${page}`, ctx)) ??
      []
    for (const entry of raw) {
      const stack = mapStack(entry)
      if (!options.openOnly || stack.open) stacks.push(stack)
    }
    if (stacks.length > options.limit) return { stacks: stacks.slice(0, options.limit), truncated: true }
    if (raw.length < STACKS_PAGE_SIZE) return { stacks, truncated: false }
  }
  return { stacks, truncated: true }
}

/** One stack in full; one that does not exist is `not_found`. */
export async function readStack(repo: RepoName, number: number, ctx: RefContext): Promise<Stack> {
  return required(
    await stackReply(repo, number, () => request<RawStack>("GET", `repos/${repo.full}/stacks/${number}`, ctx)),
  )
}

async function readPull(repo: RepoName, number: number, ctx: RefContext): Promise<RawPull> {
  let pull: RawPull | null
  try {
    pull = await request<RawPull>("GET", `repos/${repo.full}/pulls/${number}`, ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw pullRequestNotFound(repo, number, error)
    throw error
  }
  if (!pull) throw pullRequestNotFound(repo, number)
  return pull
}

/** The number of the stack a pull request is in; `null` when it is in none. */
export async function stackOfPull(repo: RepoName, number: number, ctx: RefContext): Promise<number | null> {
  return (await readPull(repo, number, ctx)).stack?.number ?? null
}

/** A pull request's state, branches and place in a stack, from one read. */
export async function readPullForStack(repo: RepoName, number: number, ctx: RefContext): Promise<StackPull> {
  const pull = await readPull(repo, number, ctx)
  return {
    number,
    state: pullState(pull),
    draft: Boolean(pull.draft),
    base: pull.base.ref,
    head: pull.head.ref,
    head_sha: pull.head.sha,
    head_repo: pull.head.repo?.full_name ?? null,
    stack: pull.stack?.number ?? null,
    position: pull.stack?.position ?? null,
  }
}

/** Makes a stack of pull requests that are in none, bottom to top; GitHub's reply is the new stack. */
export async function createStack(repo: RepoName, numbers: readonly number[], ctx: RefContext): Promise<Stack> {
  return required(
    await stackReply(repo, undefined, () =>
      request<RawStack>("POST", `repos/${repo.full}/stacks`, ctx, { pull_requests: numbers }),
    ),
  )
}

/** Puts pull requests on top of a stack, bottom to top; GitHub's reply is the stack as it is now. */
export async function addToStack(
  repo: RepoName,
  number: number,
  numbers: readonly number[],
  ctx: RefContext,
): Promise<Stack> {
  return required(
    await stackReply(repo, number, () =>
      request<RawStack>("POST", `repos/${repo.full}/stacks/${number}/add`, ctx, { pull_requests: numbers }),
    ),
  )
}

/**
 * Takes the unmerged pull requests out of a stack. The stack that remains, with
 * the merged and queued pull requests that stay in it, or `null` when GitHub
 * answers with nothing because the stack is gone.
 */
export async function unstack(repo: RepoName, number: number, ctx: RefContext): Promise<Stack | null> {
  return stackReply(repo, number, () => request<RawStack>("POST", `repos/${repo.full}/stacks/${number}/unstack`, ctx))
}
