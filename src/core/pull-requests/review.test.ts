import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { viewerRule } from "../../testing/project-fixtures"
import {
  COMMIT_SHA,
  REVIEW_URL,
  reviewPostRule,
  reviewPosts,
  stateRule,
} from "../../testing/pull-request-write-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prReview } from "./review"

const { use, run } = writeHarness(prReview)

describe("review events and stdin JSON", () => {
  test("approve sends exact stdin JSON and returns review details", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      viewerRule("alice"),
      reviewPostRule({ state: "APPROVED" }),
    ])

    const result = await run({ pr: "7", event: "approve", body: "Looks good to me" })

    expect(result).toEqual({
      repo: "octo/hello",
      pr: 7,
      review: {
        id: 101,
        state: "approved",
        url: REVIEW_URL,
        commit: COMMIT_SHA,
      },
      comments: 0,
      foreign: false,
    })

    expect(reviewPosts(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello/pulls/7/reviews", "--input", "-"],
        stdin: {
          commit_id: COMMIT_SHA,
          event: "APPROVE",
          body: "Looks good to me",
        },
      },
    ])
  })

  test("request_changes sends exact stdin JSON with line comments", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      viewerRule("alice"),
      reviewPostRule({ state: "CHANGES_REQUESTED" }),
    ])

    const result = await run({
      pr: "7",
      event: "request_changes",
      body: "Please address these findings",
      comments: [{ path: "src/index.ts", line: 42, body: "Variable is unused" }],
    })

    expect(result).toEqual({
      repo: "octo/hello",
      pr: 7,
      review: {
        id: 101,
        state: "changes_requested",
        url: REVIEW_URL,
        commit: COMMIT_SHA,
      },
      comments: 1,
      foreign: false,
    })

    expect(reviewPosts(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello/pulls/7/reviews", "--input", "-"],
        stdin: {
          commit_id: COMMIT_SHA,
          event: "REQUEST_CHANGES",
          body: "Please address these findings",
          comments: [
            {
              path: "src/index.ts",
              line: 42,
              side: "RIGHT",
              body: "Variable is unused",
            },
          ],
        },
      },
    ])
  })

  test("comment event supports single line, range, and left side line comments", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      reviewPostRule({ state: "COMMENTED" }),
    ])

    const result = await run({
      pr: "7",
      event: "comment",
      body: "A few thoughts",
      comments: [
        { path: "src/new.ts", line: 10, body: "Single line comment on new version" },
        { path: "src/range.ts", line: 25, start_line: 20, body: "Range comment on new version" },
        { path: "src/old.ts", line: 5, side: "left", body: "Comment on deleted line" },
        { path: "src/old-range.ts", line: 15, start_line: 12, side: "left", body: "Range on deleted lines" },
      ],
    })

    expect(result).toEqual({
      repo: "octo/hello",
      pr: 7,
      review: {
        id: 101,
        state: "commented",
        url: REVIEW_URL,
        commit: COMMIT_SHA,
      },
      comments: 4,
      foreign: false,
    })

    expect(reviewPosts(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello/pulls/7/reviews", "--input", "-"],
        stdin: {
          commit_id: COMMIT_SHA,
          event: "COMMENT",
          body: "A few thoughts",
          comments: [
            {
              path: "src/new.ts",
              line: 10,
              side: "RIGHT",
              body: "Single line comment on new version",
            },
            {
              path: "src/range.ts",
              line: 25,
              side: "RIGHT",
              start_line: 20,
              start_side: "RIGHT",
              body: "Range comment on new version",
            },
            {
              path: "src/old.ts",
              line: 5,
              side: "LEFT",
              body: "Comment on deleted line",
            },
            {
              path: "src/old-range.ts",
              line: 15,
              side: "LEFT",
              start_line: 12,
              start_side: "LEFT",
              body: "Range on deleted lines",
            },
          ],
        },
      },
    ])
  })

  test("comment event with line comments but no body omits body from stdin JSON", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      reviewPostRule({ state: "COMMENTED" }),
    ])

    const result = await run({
      pr: "7",
      event: "comment",
      comments: [{ path: "src/a.ts", line: 1, body: "Just this note" }],
    })

    expect(result.comments).toBe(1)
    expect(reviewPosts(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello/pulls/7/reviews", "--input", "-"],
        stdin: {
          commit_id: COMMIT_SHA,
          event: "COMMENT",
          comments: [
            {
              path: "src/a.ts",
              line: 1,
              side: "RIGHT",
              body: "Just this note",
            },
          ],
        },
      },
    ])
  })
})

describe("body rules", () => {
  test("approve without body is fine and omits body from stdin JSON", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      viewerRule("alice"),
      reviewPostRule({ state: "APPROVED" }),
    ])

    const result = await run({ pr: "7", event: "approve" })
    expect(result.review.state).toBe("approved")
    expect(reviewPosts(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello/pulls/7/reviews", "--input", "-"],
        stdin: {
          commit_id: COMMIT_SHA,
          event: "APPROVE",
        },
      },
    ])
  })

  test.each([
    ["missing body for request_changes", { pr: "7", event: "request_changes" }],
    ["blank body for request_changes", { pr: "7", event: "request_changes", body: "   " }],
    ["missing body for a comment without line comments", { pr: "7", event: "comment" }],
    ["blank body for a comment without line comments", { pr: "7", event: "comment", body: "  \n\t " }],
    ["empty comments array and blank body for comment", { pr: "7", event: "comment", body: "", comments: [] }],
  ])("%s is invalid_argument before any call to GitHub", async (_name, args) => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    const error = await failure(run(args))
    expect(error.code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})

describe("line comments validation", () => {
  test.each([
    ["start_line equal to line", 10, 10],
    ["start_line greater than line", 12, 10],
  ])("%s is refused before any call to GitHub", async (_name, startLine, line) => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    const error = await failure(
      run({
        pr: "7",
        event: "comment",
        body: "Review",
        comments: [{ path: "src/a.ts", line, start_line: startLine, body: "Comment" }],
      }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("must be less than line")
    expect(sent(installed)).toEqual([])
  })

  test("blank line comment body or path is refused before any call", async () => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    expect(
      (
        await failure(
          run({
            pr: "7",
            event: "comment",
            body: "Review",
            comments: [{ path: "  ", line: 1, body: "Comment" }],
          }),
        )
      ).code,
    ).toBe("invalid_argument")

    expect(
      (
        await failure(
          run({
            pr: "7",
            event: "comment",
            body: "Review",
            comments: [{ path: "src/a.ts", line: 1, body: "   " }],
          }),
        )
      ).code,
    ).toBe("invalid_argument")

    expect(sent(installed)).toEqual([])
  })
})

describe("head_sha", () => {
  test("head_sha matching head succeeds", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      viewerRule("alice"),
      reviewPostRule(),
    ])

    const result = await run({ pr: "7", event: "approve", head_sha: COMMIT_SHA })
    expect(result.review.commit).toBe(COMMIT_SHA)
    expect(reviewPosts(installed).length).toBe(1)
  })

  test("head_sha stale is refused with no POST", async () => {
    const installed = use([repositoryRule(), stateRule({ headRefOid: COMMIT_SHA }), reviewPostRule()])

    const otherSha = "9999999999999999999999999999999999999999"
    const error = await failure(run({ pr: "7", event: "approve", head_sha: otherSha }))

    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      `octo/hello#7 is at ${COMMIT_SHA.slice(0, 12)}, not ${otherSha.slice(0, 12)}: new commits arrived since it was read. Nothing was posted.`,
    )
    expect(reviewPosts(installed)).toEqual([])
  })

  test("invalid head_sha syntax is refused before any call", async () => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    const error = await failure(run({ pr: "7", event: "approve", head_sha: "not-a-sha" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("full commit SHA of 40 hexadecimal characters")
    expect(sent(installed)).toEqual([])
  })
})
