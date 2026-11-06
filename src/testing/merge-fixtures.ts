import type { MergeMethod } from "../core/github/pull-requests"
import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { headRef, stackFailureRule, STACK_BASE } from "./stack-fixtures"
import { sent } from "./write-fixtures"

/** Replies of GitHub the merge tool meets for `octo/hello`, and a view of the merge and branch calls a fake `gh` saw. */

type Extra = Record<string, unknown>

export const ALL_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"]

/** A commit SHA of 40 hexadecimal characters that stands for pull request `number`'s head, and for the commit its merge made. */
export const headSha = (number: number): string => String(number).padStart(40, "a")
export const mergeSha = (number: number): string => String(number).padStart(40, "b")

/** A pull request as the merge state query replies with it: open, into `main` from `feature-<number>`, in no stack. */
export const rawMergeState = (number: number, extra: Extra = {}) => ({
  number,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: headSha(number),
  headRefName: headRef(number),
  baseRefName: STACK_BASE,
  isCrossRepository: false,
  mergeCommit: null,
  stack: null,
  stackEntry: null,
  ...extra,
})

/** The part of the merge state reply that puts the pull request at `position` of stack `stack`. */
export const stackedAt = (stack: number, position: number) => ({ stack: { number: stack }, stackEntry: { position } })

/** The part of the merge state reply of a pull request that merged. */
export const mergedState = (number: number) => ({ state: "MERGED", mergeCommit: { oid: mergeSha(number) } })

/** The merge state query for one pull request; each token is one only that query holds. */
export const mergeStateRule = (number: number, extra: Extra = {}, times?: number): GhRule => ({
  match: `mergeCommit\\{oid\\}[\\s\\S]*-F n=${number}$`,
  stdout: gqlReply({ repository: { pullRequest: rawMergeState(number, extra) } }),
  times,
})

/** The merge state of a pull request before the merge (the first read) and after it (every later read). */
export const mergingRules = (number: number, before: Extra = {}, after: Extra = mergedState(number)): GhRule[] => [
  mergeStateRule(number, before, 1),
  mergeStateRule(number, { ...before, ...after }),
]

/** The repository's settings: which merge methods it allows. */
export const methodsRule = (...allowed: MergeMethod[]): GhRule => ({
  match: "squashMergeAllowed",
  stdout: gqlReply({
    repository: {
      mergeCommitAllowed: allowed.includes("merge"),
      squashMergeAllowed: allowed.includes("squash"),
      rebaseMergeAllowed: allowed.includes("rebase"),
    },
  }),
})

/** GitHub's reply to a merge request, and to reading one. */
export const mergeReply = (status: string, details: Extra = {}) => ({ status, details: { message: "ok", ...details } })
export const pendingReply = (uuid = "uuid-1") => mergeReply("pending", { uuid })

const putMatch = (number: number): string => `-X PUT [\\s\\S]*pulls/${number}/merge-async --input`
const pollMatch = (number: number): string => `pulls/${number}/merge-async/[\\w-]+$`

/** `PUT pulls/<n>/merge-async`, answered with `reply`. */
export const mergePutRule = (number: number, reply: unknown = pendingReply()): GhRule => ({
  match: putMatch(number),
  stdout: JSON.stringify(reply),
})

/** `PUT pulls/<n>/merge-async`, failing the way `gh api` reports `status`. */
export const mergePutFailureRule = (number: number, status: string): GhRule =>
  stackFailureRule(putMatch(number), status)

/** `GET pulls/<n>/merge-async/<uuid>`, answered with `reply`; `times` limits how many reads it answers. */
export const mergePollRule = (number: number, reply: unknown, times?: number): GhRule => ({
  match: pollMatch(number),
  stdout: JSON.stringify(reply),
  times,
})

/** `GET pulls/<n>/merge-async/<uuid>`, failing the way `gh api` reports `status`. */
export const mergePollFailureRule = (number: number, status: string): GhRule =>
  stackFailureRule(pollMatch(number), status)

/** The merge requests that went out, with the body each sent. */
export function mergePuts(installed: FakeGh): { path: string; body: Record<string, unknown> }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) =>
      args[0] === "api" && args.includes("PUT")
        ? [{ path: args.find((arg) => arg.startsWith("repos/"))!, body: JSON.parse(stdins[index] ?? "{}") }]
        : [],
    )
}

/** The branch deletions that went out, as the ref path each asked for. */
export const branchDeletes = (installed: FakeGh): string[] =>
  sent(installed).flatMap((args) =>
    args[0] === "api" && args.includes("DELETE") ? args.filter((arg) => arg.startsWith("repos/")) : [],
  )

export const defaultBranchRule = (name: string | null = STACK_BASE): GhRule => ({
  match: "defaultBranchRef",
  stdout: gqlReply({ repository: { defaultBranchRef: name === null ? null : { name } } }),
})

/** `GET branches/<name>`: the branch is at `sha`, or gone for `null`. */
export const branchRule = (name: string, sha: string | null): GhRule =>
  sha === null
    ? stackFailureRule(`branches/${name}$`, "Not Found (HTTP 404)")
    : { match: `branches/${name}$`, stdout: JSON.stringify({ commit: { sha } }) }

/** `gh pr list --base`: these open pull requests are based on the branch. */
export const basedOnRule = (...numbers: number[]): GhRule => ({
  match: "^pr list",
  stdout: JSON.stringify(numbers.map((number) => ({ number }))),
})

export const branchDeleteRule = (name: string, failure?: string): GhRule =>
  failure === undefined
    ? { match: `-X DELETE repos/octo/hello/git/refs/heads/${name}$` }
    : stackFailureRule(`-X DELETE repos/octo/hello/git/refs/heads/${name}$`, failure)
