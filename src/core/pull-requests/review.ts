import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { ghJson } from "../gh"
import { viewerLogin } from "../github/projects"
import { readPullRequestState } from "../github/pull-requests"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../write-support"
import { parseNumberRef, SHA_PATTERN, shortSha } from "../refs"
import { githubTargets } from "../github/targets"
import { defineTool, type CallFact } from "../tool"
import { PR_DESCRIPTION, PR_TARGETS, describedPull } from "./write-support"

const OPEN = "open"
const BLOCK_SEPARATOR = "\n\n"
const NOT_IN_DIFF =
  /could not be resolved|must be part of the diff|pull_request_review_thread\.line|is outside the diff/i

const EVENT_VALUES = ["approve", "request_changes", "comment"] as const
export type ReviewEvent = (typeof EVENT_VALUES)[number]

const lineCommentSchema = z.object({
  path: z.string().describe("The file path the line comment is on."),
  line: z.number().int().min(1).describe("The line number in the diff to comment on."),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The start line of a multi-line comment range (must be less than line)."),
  side: z
    .enum(["left", "right"])
    .optional()
    .describe("Which side of the diff: right for the new version (default), left for the old one."),
  body: z.string().describe("The line comment text, in Markdown."),
})

const input = z.object({
  pr: z.string().describe(PR_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  event: z.enum(EVENT_VALUES).describe("The review action: approve, request_changes, or comment."),
  body: z
    .string()
    .optional()
    .describe(
      "The review text. Required for request_changes and for comment without line comments; optional for approve.",
    ),
  comments: z.array(lineCommentSchema).max(50).optional().describe("Optional array of up to 50 line comments."),
  head_sha: z
    .string()
    .optional()
    .describe("Optional 40-character commit SHA the review was based on. Fails if new commits arrived."),
})

const reviewSchema = z.object({
  id: z.number().int().describe("The review's ID."),
  state: z.string().describe("approved, changes_requested, or commented."),
  url: z.string().describe("The review's URL."),
  commit: z.string().describe("The commit SHA the review was posted on."),
})

const output = z.object({
  repo: z.string(),
  pr: z.number().int(),
  review: reviewSchema,
  comments: z.number().int().describe("How many line comments were posted with the review."),
  foreign: z.boolean(),
})

type ReviewResponse = {
  id: number
  state: string
  html_url: string
  commit_id: string
}

const EVENT_PAYLOAD_MAP = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const

/** What the headline says the call is about to do, by the review's event. */
const HEADLINES: Readonly<Record<ReviewEvent, string>> = {
  approve: "About to approve the pull request {title}",
  request_changes: "About to request changes on the pull request {title}",
  comment: "About to review the pull request {title} with comments",
}

type ReviewArgs = z.output<typeof input>
type LineComment = z.output<typeof lineCommentSchema>

/** The review's arguments as `execute` checks them, before any call to GitHub; refuses what it refuses. */
function checkedReview(args: ReviewArgs): { body: string | undefined; comments: LineComment[]; expectedSha?: string } {
  const body = given(args.body)
  if (args.event === "request_changes" && !body) {
    throw invalid("request_changes requires a body explaining the requested changes.")
  }

  const comments = args.comments ?? []
  if (args.event === "comment" && !body && comments.length === 0) {
    throw invalid("A comment review needs a body or at least one line comment.")
  }

  for (const comment of comments) {
    if (!given(comment.path)) throw invalid("Line comment path cannot be blank.")
    if (!given(comment.body)) throw invalid("Line comment body cannot be blank.")
    if (comment.start_line !== undefined && comment.start_line >= comment.line) {
      throw invalid(`start_line (${comment.start_line}) must be less than line (${comment.line}).`)
    }
  }

  const expectedSha = given(args.head_sha)
  if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
    throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
  }
  return { body, comments, expectedSha }
}

/** Where a line comment goes, as `path:line`, `path:start-line` for a range, and `(left)` for the old version. */
function placeOf(comment: LineComment): string {
  const lines = comment.start_line === undefined ? `${comment.line}` : `${comment.start_line}-${comment.line}`
  return `${comment.path}:${lines}${comment.side === "left" ? " (left)" : ""}`
}

/** The `Line comments` fact, with the count in the singular or the plural. */
function lineCommentsFact(count: number): CallFact {
  return {
    label: "Line comments",
    value: { text: count === 1 ? "{count} comment" : "{count} comments", values: { count } },
  }
}

export const prReview = defineTool({
  id: "github_pr_review",
  title: "Review a GitHub pull request",
  intent: "About to review a GitHub pull request",
  description: [
    "Post a review on a pull request: approve to approve changes, request_changes to request revisions (body required), or comment for general feedback.",
    "Only an open pull request can be approved or have changes requested, and GitHub does not let an author approve their own pull request or request changes on it.",
    "Line comments can be attached: path and line in the new version (or side left for a removed line), and start_line for a multi-line range.",
    "Pass head_sha to ensure the review posts only on the commit that was reviewed; if new commits arrived, the call fails without posting.",
    "A pull request is 12, #12, owner/repo#12 or its URL; a bare number means the working tree's repository, or repo.",
  ].join(" "),
  toolset: "pull_requests",
  class: "add",
  targets: githubTargets(PR_TARGETS),
  async describe(args, ctx) {
    const { body, comments, expectedSha } = checkedReview(args)
    const { ref, heading } = await describedPull(args, ctx)
    const label = `${ref.repo.full}#${ref.number}`

    if (expectedSha && heading.head_sha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${label} is at ${shortSha(heading.head_sha)}, not ${shortSha(expectedSha)}: new commits arrived since it was read. Nothing was posted.`,
      )
    }
    if (args.event === "approve" || args.event === "request_changes") {
      if (heading.state !== OPEN) {
        throw invalid(
          `${label} is ${heading.state}; only an open pull request can be approved or have changes requested.`,
        )
      }
      const author = (await readPullRequestState(ref, ctx)).author
      const viewer = await viewerLogin(ctx)
      if (author && viewer.toLowerCase() === author.toLowerCase()) {
        throw invalid(
          `GitHub does not let the author of ${label} approve it or request changes on it; post event comment instead.`,
        )
      }
    }

    const facts: CallFact[] = [{ label: "Commit", value: shortSha(heading.head_sha) }]
    if (comments.length > 0) facts.push(lineCommentsFact(comments.length))
    const blocks = [...(body ? [body] : []), ...comments.map((comment) => `${placeOf(comment)}\n${comment.body}`)]
    return {
      headline: { text: HEADLINES[args.event], values: { title: heading.title } },
      facts,
      ...(blocks.length > 0 ? { text: { label: "Review", body: blocks.join(BLOCK_SEPARATOR) } } : {}),
      pins: { head_sha: heading.head_sha },
    }
  },
  input,
  output,
  async execute(args, ctx) {
    // 1. Argument checks (all before any call).
    const body = given(args.body)
    if (args.event === "request_changes" && !body) {
      throw invalid("request_changes requires a body explaining the requested changes.")
    }

    const comments = args.comments ?? []
    if (args.event === "comment" && !body && comments.length === 0) {
      throw invalid("A comment review needs a body or at least one line comment.")
    }

    for (const comment of comments) {
      if (!given(comment.path)) throw invalid("Line comment path cannot be blank.")
      if (!given(comment.body)) throw invalid("Line comment body cannot be blank.")
      if (comment.start_line !== undefined && comment.start_line >= comment.line) {
        throw invalid(`start_line (${comment.start_line}) must be less than line (${comment.line}).`)
      }
    }

    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }

    // 2. Parse pr with accept: "pull", writableContext, readPullRequestState.
    const ref = await parseNumberRef(args.pr, args.repo, ctx, { accept: "pull" })
    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const current = await readPullRequestState({ repo: target, number: ref.number }, ctx)

    if (expectedSha && current.head_sha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${target.full}#${ref.number} is at ${current.head_sha.slice(0, 12)}, not ${expectedSha.slice(0, 12)}: new commits arrived since it was read. Nothing was posted.`,
      )
    }

    // 3. approve or request_changes on a pull request that is not open -> invalid_argument
    if ((args.event === "approve" || args.event === "request_changes") && current.state !== OPEN) {
      throw invalid(
        `${target.full}#${ref.number} is ${current.state}; only an open pull request can be approved or have changes requested.`,
      )
    }

    // 4. approve or request_changes when the author is the viewer -> invalid_argument
    if (args.event === "approve" || args.event === "request_changes") {
      const viewer = await viewerLogin(ctx)
      if (current.author && viewer.toLowerCase() === current.author.toLowerCase()) {
        throw invalid(
          `GitHub does not let the author of ${target.full}#${ref.number} approve it or request changes on it; post event comment instead.`,
        )
      }
    }

    // 5. gh api -X POST repos/<owner>/<name>/pulls/<n>/reviews --input -
    const commentsPayload = comments.map((comment) => {
      const side = (comment.side ?? "right").toUpperCase()
      return {
        path: comment.path,
        line: comment.line,
        side,
        ...(comment.start_line !== undefined
          ? {
              start_line: comment.start_line,
              start_side: side,
            }
          : {}),
        body: comment.body,
      }
    })

    const payload: {
      commit_id: string
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
      body?: string
      comments?: typeof commentsPayload
    } = {
      commit_id: current.head_sha,
      event: EVENT_PAYLOAD_MAP[args.event],
    }

    if (body) payload.body = body
    if (commentsPayload.length > 0) payload.comments = commentsPayload

    let response: ReviewResponse | null
    try {
      response = await ghJson<ReviewResponse>(
        ["api", "-X", "POST", `repos/${target.owner}/${target.name}/pulls/${ref.number}/reviews`, "--input", "-"],
        {
          cwd: ctx.cwd,
          signal: ctx.signal,
          stdin: JSON.stringify(payload),
        },
      )
    } catch (error) {
      // 6. Line not part of diff error mapping
      if (isToolError(error) && NOT_IN_DIFF.test(error.message)) {
        throw new ToolError(
          "invalid_argument",
          `A line comment is not on a line the pull request changes: ${error.message}. github_pr_read diff shows the changed lines.`,
          { cause: error },
        )
      }
      throw error
    }

    if (!response) {
      throw new ToolError("upstream_error", "GitHub did not return the created review.")
    }

    return {
      repo: target.full,
      pr: ref.number,
      review: {
        id: response.id,
        state: response.state.toLowerCase(),
        url: response.html_url,
        commit: response.commit_id,
      },
      comments: commentsPayload.length,
      foreign: context.foreign,
    }
  },
})
