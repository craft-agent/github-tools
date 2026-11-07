import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import {
  MERGE_METHODS,
  readMergeMethods,
  readMergeState,
  type MergeMethod,
  type MergeState,
  type PullRequestRef,
} from "../github/pull-requests"
import { readStack } from "../github/stacks"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../issues/write-support"
import { stepErrorsSchema } from "../projects/item-support"
import { parseNumberRef, SHA_PATTERN, shortSha, type RepoName } from "../refs"
import { StepErrors, defineTool, type ToolContext } from "../tool"
import { branchOutcomeSchema, tidyBranches, type BranchTarget } from "./merge-branches"
import {
  MERGE_POLL_INTERVAL_MS,
  MERGE_POLL_TIMEOUT_MS,
  MERGE_STATUSES,
  followMerge,
  startMerge,
  type MergeProgress,
  type MergeRequestBody,
} from "./merge-request"
import { PR_DESCRIPTION, PR_TARGETS } from "./write-support"

const CONFLICT_FAILURE = /http 409/i
const PENDING_NOTE = "GitHub is still merging; github_pr_read view shows when it lands."
const ENQUEUED_NOTE = "In the merge queue; it merges when the queue reaches it."
const BRANCH_KEPT_NOTE =
  "The head branch of a pull request that has not merged yet was not deleted; delete it once it lands."
const NO_REASON = "GitHub gave no reason"

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  method: z
    .enum(MERGE_METHODS)
    .optional()
    .describe(
      "How to merge: merge, squash or rebase. Optional when the repository allows only one; required when it allows several.",
    ),
  head_sha: z
    .string()
    .optional()
    .describe(
      "Optional 40-character commit SHA the pull request was reviewed at. Fails with stale, merging nothing, if new commits arrived.",
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "The merge or squash commit's title. Not for rebase. For a stacked merge it applies to the named pull request only.",
    ),
  body: z
    .string()
    .optional()
    .describe(
      "The merge or squash commit's message. Not for rebase. For a stacked merge it applies to the named pull request only.",
    ),
  delete_branch: z
    .boolean()
    .optional()
    .describe("Delete the head branch of each pull request that merged, best effort (default false)."),
  with_lower_layers: z
    .boolean()
    .optional()
    .describe(
      "For a pull request in a stack: also merge the open layers below it, which merging it does anyway (default false: refuse and list them).",
    ),
})

const layerSchema = z.object({
  number: z.number().int(),
  state: z.string().describe("open, closed or merged."),
  merge_commit: z.string().nullable().describe("The commit the merge made; null until it is merged."),
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  method: z
    .enum(MERGE_METHODS)
    .nullable()
    .describe("The method of the merge request; null when the pull request was merged already and none was asked."),
  status: z
    .enum(MERGE_STATUSES)
    .describe(
      "merged; enqueued: in the merge queue; pending: GitHub is still merging when the wait ended; failed: GitHub could not merge it.",
    ),
  merged: z
    .array(layerSchema)
    .describe("The pull request and the open layers below it that the merge took along, bottom to top, as read after."),
  request: z.string().nullable().describe("GitHub's ID of the merge request; null when none was made."),
  branches: z.array(branchOutcomeSchema).describe("What became of each head branch; [] without delete_branch."),
  changed: z.boolean().describe("False when the pull request was merged already and nothing was sent."),
  notes: z.array(z.string()).describe("What to know about the result; [] when nothing."),
  foreign: z.boolean(),
  errors: stepErrorsSchema,
})

const layerOf = (state: MergeState) => ({
  number: state.number,
  state: state.state,
  merge_commit: state.merge_commit,
})

const numbersOf = (numbers: readonly number[]): string => numbers.map((number) => `#${number}`).join(", ")

function refuseCommitMessage(subject: string | undefined, body: string | undefined): void {
  if (subject !== undefined || body !== undefined) {
    throw invalid("subject and body are for a merge or squash commit; a rebase makes no merge commit.")
  }
}

/** Refuses a pull request GitHub could not merge for a reason that is no rule of the repository: closed, a draft, conflicts. */
function refuseUnmergeable(pull: MergeState, label: string): void {
  if (pull.state === "closed") throw invalid(`${label} is closed; reopen it with github_pr_reopen first.`)
  if (pull.draft) throw invalid(`${label} is a draft; mark it ready with github_pr_ready first.`)
  if (pull.mergeable === "conflicting" || pull.merge_state === "dirty") {
    throw invalid(`${label} has conflicts with ${pull.base}; resolve them first.`)
  }
}

async function chooseMethod(
  requested: MergeMethod | undefined,
  repo: RepoName,
  ctx: ToolContext,
): Promise<MergeMethod> {
  const allowed = await readMergeMethods(repo, ctx)
  const list = allowed.join(", ")
  if (allowed.length === 0) throw invalid(`${repo.full} allows no merge method; change its settings first.`)
  if (requested) {
    if (!allowed.includes(requested)) {
      throw invalid(`${repo.full} does not allow ${requested} merges; the allowed methods are: ${list}.`)
    }
    return requested
  }
  if (allowed.length === 1) return allowed[0]!
  throw invalid(`${repo.full} allows several merge methods; pass method: one of ${list}.`)
}

/**
 * The open layers below `pull` in its stack, which merging it takes along, read
 * for their merge state. None when it is in no stack or is the bottom one.
 * Merging them needs `withLower`; one that is a draft or in conflict is refused.
 */
async function lowerLayers(
  pull: MergeState,
  repo: RepoName,
  withLower: boolean,
  ctx: ToolContext,
): Promise<MergeState[]> {
  const place = pull.stack
  if (!place || place.position <= 1) return []
  const stack = await readStack(repo, place.number, ctx)
  const open = stack.layers
    .filter((layer) => layer.position < place.position && layer.state === "open")
    .map((layer) => layer.number)
  if (open.length === 0) return []
  const label = `${repo.full}#${pull.number}`
  if (!withLower) {
    throw invalid(
      `${label} is layer ${place.position} of stack #${place.number}; merging it also merges the open layers below it: ${numbersOf(open)}. Pass with_lower_layers: true to merge them together, or merge #${open[0]} first.`,
    )
  }
  const states = await Promise.all(open.map((number) => readMergeState({ repo, number }, ctx)))
  const taken = states.filter((state) => state.state !== "merged")
  for (const state of taken) refuseUnmergeable(state, `${repo.full}#${state.number} (a layer below #${pull.number})`)
  return taken
}

/**
 * Sends the merge request; `null` when another request merged the pull request
 * first. GitHub answers 409 while another merge of it is pending, with that
 * request's ID in the body, which the `gh` runner does not pass on (it keeps
 * only GitHub's `errors`), so the other request cannot be followed: the pull
 * request is read instead, and the call goes on if it has merged by now.
 */
async function requestMerge(
  ref: PullRequestRef,
  label: string,
  body: MergeRequestBody,
  ctx: ToolContext,
): Promise<MergeProgress | null> {
  try {
    return await startMerge(ref.repo, ref.number, body, ctx)
  } catch (error) {
    if (!isToolError(error) || error.code !== "stale" || !CONFLICT_FAILURE.test(error.message)) throw error
    const now = await readMergeState(ref, ctx)
    if (now.state === "merged") return null
    if (now.head_sha.toLowerCase() !== body.sha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${label} is at ${shortSha(now.head_sha)}, not ${shortSha(body.sha)}: new commits arrived since it was read. Nothing was merged.`,
        { cause: error },
      )
    }
    throw new ToolError(
      "stale",
      `Another merge of ${label} is already running; read it again with github_pr_read view.`,
      { cause: error },
    )
  }
}

export const prMerge = defineTool({
  id: "github_pr_merge",
  title: "Merge a GitHub pull request",
  description: [
    "Merge a pull request with merge, squash or rebase. Every pull request, stacked or not, merges through one GitHub request that this call follows until it ends.",
    "method may be left out when the repository allows only one; when it allows several, or the one asked is not allowed, the call fails saying which are.",
    "Pass head_sha, the commit that was reviewed, to merge only that: if new commits arrived the call fails with stale and merges nothing. The head merged is always the one read at the start.",
    "subject and body set the merge or squash commit's title and message; a rebase makes no merge commit, so they are refused with it.",
    "A closed pull request, a draft and one with conflicts are refused before anything is sent, and so is a merged one: it is left as it is, changed is false and nothing else merges.",
    "Whether the branch rules and required checks are met is GitHub's to enforce: a pull request they block, or one that is behind its base or unstable, is sent anyway and GitHub's refusal is returned. Nothing bypasses the rules, and a repository that requires a merge queue queues it (status enqueued).",
    "In a native stack, merging a layer also merges every open layer below it, each as its own commit, while the layers above stay open and GitHub retargets them. That is refused, listing the layers below, unless with_lower_layers is true; a lower layer that is a draft or in conflict is refused by name. subject and body apply to the named layer only.",
    `The call waits up to ${MERGE_POLL_TIMEOUT_MS / 1000} seconds, reading the request every ${MERGE_POLL_INTERVAL_MS / 1000}. If GitHub is still merging then, status is pending with a note: read the pull request later with github_pr_read view. The result lists the pull request and the layers taken along as read after the merge.`,
    "delete_branch deletes the head branch of each pull request that merged, bottom to top, best effort and never failing the call: the default branch, a branch another open pull request is based on, one in a fork and one with new commits since the merge are kept, and branches reports each result.",
    "Merging closes the issues the pull request names, in other repositories too.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "pull_requests",
  class: "administrative",
  targets: PR_TARGETS,
  input,
  output,
  async execute(args, ctx) {
    // 1. Argument checks (all before any call).
    const subject = given(args.subject)
    const message = given(args.body)
    if (args.method === "rebase") refuseCommitMessage(subject, message)
    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }

    // 2. The permission gate and the pull request.
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const pullRef = { repo: target, number: ref.number }
    const label = `${target.full}#${ref.number}`
    const pull = await readMergeState(pullRef, ctx)
    const result = { repo: target.full, pr: ref.number, foreign: context.foreign }

    // 3. Merged already: nothing to send. Closed, a draft and conflicts are refused.
    if (pull.state === "merged") {
      return {
        ...result,
        method: args.method ?? null,
        status: "merged" as const,
        merged: [layerOf(pull)],
        request: null,
        branches: [],
        changed: false,
        notes: [],
        errors: {},
      }
    }
    refuseUnmergeable(pull, label)

    // 4. The method.
    const method = await chooseMethod(args.method, target, ctx)
    if (method === "rebase") refuseCommitMessage(subject, message)

    // 5. The head the caller saw.
    if (expectedSha && pull.head_sha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${label} is at ${shortSha(pull.head_sha)}, not ${shortSha(expectedSha)}: new commits arrived since it was read. Nothing was merged.`,
      )
    }

    // 6. The layers below, which the merge takes along.
    const lower = await lowerLayers(pull, target, Boolean(args.with_lower_layers), ctx)
    const layers = [...lower, pull]

    // 7. Merge, 8. wait for the answer.
    const body: MergeRequestBody = {
      merge_method: method,
      sha: pull.head_sha,
      ...(subject ? { commit_title: subject } : {}),
      ...(message ? { commit_message: message } : {}),
    }
    const sent = await requestMerge(pullRef, label, body, ctx)
    const outcome = sent
      ? await followMerge(target, ref.number, sent, ctx)
      : { status: "merged" as const, message: null, uuid: null, poll_error: null }

    // 9. Read back every pull request the merge touched.
    const steps = new StepErrors()
    const after =
      (await steps.record("read", () =>
        Promise.all(layers.map((layer) => readMergeState({ repo: target, number: layer.number }, ctx))),
      )) ?? layers
    const named = after[after.length - 1]!
    const status = outcome.status === "pending" && named.state === "merged" ? "merged" : outcome.status

    // 10. A failed merge is an error only when it merged nothing.
    const errors = steps.errors
    if (outcome.poll_error) errors.poll = outcome.poll_error
    if (status === "failed") {
      const reason = outcome.message?.trim() || NO_REASON
      if (!after.some((layer) => layer.state === "merged")) {
        throw new ToolError("github_error", `GitHub could not merge ${label}: ${reason.replace(/\.$/, "")}.`)
      }
      errors.merge = reason
    }

    const unmergedBranches = args.delete_branch && after.some((layer) => layer.state !== "merged")
    const notes = [
      ...(status === "pending" ? [PENDING_NOTE] : []),
      ...(status === "enqueued" ? [ENQUEUED_NOTE] : []),
      ...(unmergedBranches ? [BRANCH_KEPT_NOTE] : []),
    ]
    const branchTargets: BranchTarget[] = layers.flatMap((layer, index) =>
      args.delete_branch && after[index]!.state === "merged"
        ? [{ name: layer.head, head_sha: layer.head_sha, cross_repository: layer.cross_repository }]
        : [],
    )

    return {
      ...result,
      method,
      status,
      merged: after.map(layerOf),
      request: outcome.uuid,
      branches: await tidyBranches(target, branchTargets, ctx),
      changed: sent !== null,
      notes,
      errors,
    }
  },
})
