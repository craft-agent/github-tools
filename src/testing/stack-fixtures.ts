import type { FakeGh, GhRule } from "./fake-gh"
import { sent } from "./write-fixtures"

/** Replies of GitHub's stack REST API for `octo/hello`, what the stack tools make of them, and a view of the calls a fake `gh` saw. */

type Extra = Record<string, unknown>

/** The stack's base branch, and the branch the bottom pull request is based on. */
export const STACK_BASE = "main"
export const headRef = (number: number): string => `feature-${number}`
const baseOf = (numbers: readonly number[], index: number): string =>
  index === 0 ? STACK_BASE : headRef(numbers[index - 1]!)

const rawStackPull = (number: number, extra: Extra = {}) => ({
  number,
  state: "open",
  draft: false,
  merged_at: null,
  head: { ref: headRef(number), sha: `sha-${number}` },
  ...extra,
})

/** A stack as the list gives it: the short form of each pull request. Bottom to top, like `numbers`. */
export const rawStack = (
  number: number,
  numbers: readonly number[],
  pulls: Record<number, Extra> = {},
  extra: Extra = {},
) => ({
  id: 9000 + number,
  number,
  node_id: `S_${number}`,
  base: { ref: STACK_BASE },
  open: true,
  created_at: "2026-11-01T00:00:00Z",
  pull_requests: numbers.map((n) => rawStackPull(n, pulls[n])),
  ...extra,
})

/** A stack as a read or a write gives it: the full form of each pull request. */
export const rawFullStack = (
  number: number,
  numbers: readonly number[],
  pulls: Record<number, Extra> = {},
  extra: Extra = {},
) =>
  rawStack(
    number,
    numbers,
    Object.fromEntries(
      numbers.map((n, index) => [
        n,
        {
          title: `Pull request ${n}`,
          html_url: `https://github.com/octo/hello/pull/${n}`,
          base: { ref: baseOf(numbers, index), sha: `base-${n}` },
          user: { login: "alice" },
          ...pulls[n],
        },
      ]),
    ),
    extra,
  )

/** What a tool makes of a stack: `full` for the full form, else the short one. */
export const expectedStack = (
  number: number,
  numbers: readonly number[],
  options: { full: boolean; pulls?: Record<number, Extra> } = { full: true },
) => ({
  number,
  base: STACK_BASE,
  open: true,
  size: numbers.length,
  layers: numbers.map((n, index) => ({
    position: index + 1,
    number: n,
    title: options.full ? `Pull request ${n}` : null,
    state: "open",
    draft: false,
    head: headRef(n),
    head_sha: `sha-${n}`,
    base: options.full ? baseOf(numbers, index) : null,
    url: options.full ? `https://github.com/octo/hello/pull/${n}` : null,
    ...options.pulls?.[n],
  })),
})

/** `GET pulls/<n>`: an open pull request of `octo/hello` based on the head of `below` (the stack's base for none). */
export const pullRule = (number: number, below: number | null, extra: Extra = {}): GhRule => ({
  match: `repos/octo/hello/pulls/${number}$`,
  stdout: JSON.stringify({
    number,
    state: "open",
    draft: false,
    merged_at: null,
    base: { ref: below === null ? STACK_BASE : headRef(below) },
    head: { ref: headRef(number), sha: `sha-${number}`, repo: { full_name: "octo/hello" } },
    stack: null,
    ...extra,
  }),
})

/** `GET pulls/<n>` for pull requests that chain bottom to top; `extra` adjusts the reply of single ones. */
export const chainRules = (numbers: readonly number[], extra: Record<number, Extra> = {}): GhRule[] =>
  numbers.map((number, index) => pullRule(number, numbers[index - 1] ?? null, extra[number]))

/** The `stack` field of a pull request that is the `position`th of stack `number`. */
export const inStack = (number: number, position: number, size = position) => ({
  stack: { number, position, size, id: 9000 + number, base: { ref: STACK_BASE, sha: "base-sha" } },
})

export const stackRule = (number: number, stack: unknown): GhRule => ({
  match: `repos/octo/hello/stacks/${number}$`,
  stdout: JSON.stringify(stack),
})

export const stackPageRule = (page: number, stacks: unknown[]): GhRule => ({
  match: `repos/octo/hello/stacks\\?per_page=100&page=${page}$`,
  stdout: JSON.stringify(stacks),
})

/** `POST stacks` (create), `POST stacks/<n>/add` and `POST stacks/<n>/unstack`; the reply is empty for `undefined`. */
export const createRule = (reply?: unknown): GhRule => ({
  match: "repos/octo/hello/stacks --input",
  stdout: reply === undefined ? "" : JSON.stringify(reply),
})
export const addRule = (number: number, reply: unknown): GhRule => ({
  match: `repos/octo/hello/stacks/${number}/add`,
  stdout: JSON.stringify(reply),
})
export const unstackRule = (number: number, reply?: unknown): GhRule => ({
  match: `repos/octo/hello/stacks/${number}/unstack`,
  stdout: reply === undefined ? "" : JSON.stringify(reply),
})

/** A failed call of the stack API, the way `gh api` reports it: the status on stderr, the reply body on stdout. */
export const stackFailureRule = (match: string, status: string, body: Extra = {}): GhRule => ({
  match,
  stderr: `gh: ${status}`,
  stdout: JSON.stringify(body),
  code: 1,
})

/** The calls that wrote to the stack API, with the path they went to and the body they sent. */
export function stackPosts(installed: FakeGh): { path: string; body: unknown }[] {
  const stdins = installed.stdins()
  return installed.calls().flatMap((args, index) =>
    args[0] === "api" && args.includes("POST")
      ? [
          {
            path: args.find((arg) => arg.startsWith("repos/"))!,
            body: stdins[index] ? JSON.parse(stdins[index]!) : null,
          },
        ]
      : [],
  )
}

/** Every `gh api` call that went out, as the path it asked for. */
export const apiPaths = (installed: FakeGh): string[] =>
  sent(installed).flatMap((args) => (args[0] === "api" ? args.filter((arg) => arg.startsWith("repos/")) : []))
