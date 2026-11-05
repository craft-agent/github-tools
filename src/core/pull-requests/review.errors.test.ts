import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { viewerRule } from "../../testing/project-fixtures"
import { reviewPostRule, reviewPosts, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prReview } from "./review"

const { use, run } = writeHarness(prReview)

describe("state and author refusals", () => {
  test.each(["CLOSED", "MERGED"])("approve on a %s pull request is refused with no POST", async (state) => {
    const installed = use([repositoryRule(), stateRule({ state }), reviewPostRule()])
    const error = await failure(run({ pr: "7", event: "approve" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      `octo/hello#7 is ${state.toLowerCase()}; only an open pull request can be approved or have changes requested.`,
    )
    expect(reviewPosts(installed)).toEqual([])
  })

  test.each(["CLOSED", "MERGED"])("request_changes on a %s pull request is refused with no POST", async (state) => {
    const installed = use([repositoryRule(), stateRule({ state }), reviewPostRule()])
    const error = await failure(run({ pr: "7", event: "request_changes", body: "Needs fixes" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      `octo/hello#7 is ${state.toLowerCase()}; only an open pull request can be approved or have changes requested.`,
    )
    expect(reviewPosts(installed)).toEqual([])
  })

  test("comment on a closed pull request is allowed", async () => {
    const installed = use([
      repositoryRule(),
      stateRule({ state: "CLOSED", author: { login: "someone" } }),
      reviewPostRule({ state: "COMMENTED" }),
    ])

    const result = await run({ pr: "7", event: "comment", body: "Commenting on closed PR" })
    expect(result.review.state).toBe("commented")
    expect(reviewPosts(installed).length).toBe(1)
  })

  test("the author approving is refused with no POST", async () => {
    const installed = use([
      repositoryRule({ viewer: "octo" }),
      stateRule({ author: { login: "octo" } }),
      viewerRule("octo"),
      reviewPostRule(),
    ])

    const error = await failure(run({ pr: "7", event: "approve" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "GitHub does not let the author of octo/hello#7 approve it or request changes on it; post event comment instead.",
    )
    expect(reviewPosts(installed)).toEqual([])
  })

  test("the author requesting changes is refused with no POST (case-insensitive)", async () => {
    const installed = use([
      repositoryRule({ viewer: "octo" }),
      stateRule({ author: { login: "OCTO" } }),
      viewerRule("octo"),
      reviewPostRule(),
    ])

    const error = await failure(run({ pr: "7", event: "request_changes", body: "Cannot review own PR" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "GitHub does not let the author of octo/hello#7 approve it or request changes on it; post event comment instead.",
    )
    expect(reviewPosts(installed)).toEqual([])
  })
})

describe("error mapping", () => {
  test.each([
    ["could not be resolved", "HTTP 422: Unprocessable Entity (could not be resolved)"],
    ["Line could not be resolved", "HTTP 422: Line could not be resolved on diff"],
    ["must be part of the diff", "HTTP 422: Line must be part of the diff"],
    ["pull_request_review_thread.line", "HTTP 422: Validation Failed: pull_request_review_thread.line is invalid"],
    ["is outside the diff", "HTTP 422: The position is outside the diff"],
  ])("the not-in-diff 422 (%s) is mapped to invalid_argument with cause preserved", async (_label, stderr) => {
    use([repositoryRule(), stateRule({ author: { login: "someone" } }), reviewPostRule({ stderr })])

    const error = await failure(
      run({
        pr: "7",
        event: "comment",
        body: "Note",
        comments: [{ path: "src/a.ts", line: 999, body: "bad line" }],
      }),
    )

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("A line comment is not on a line the pull request changes:")
    expect(error.message).toContain("github_pr_read diff shows the changed lines.")
    expect(error.cause).toBeDefined()
  })

  test("another failure (403 forbidden) keeps its code", async () => {
    use([
      repositoryRule(),
      stateRule({ author: { login: "someone" } }),
      viewerRule("alice"),
      reviewPostRule({ stderr: "HTTP 403: Resource not accessible by integration" }),
    ])

    const error = await failure(run({ pr: "7", event: "approve" }))
    expect(error.code).toBe("forbidden")
  })
})

describe("permission and repository context", () => {
  test("denied write permission is forbidden and nothing is posted", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), reviewPostRule()])
    const error = await failure(run({ pr: "7", event: "approve" }))
    expect(error.code).toBe("forbidden")
    expect(reviewPosts(installed)).toEqual([])
  })

  test("foreign repository reports foreign: true", async () => {
    use([
      repositoryRule({ repo: "other/repo", viewer: "me" }),
      stateRule({ author: { login: "someone" } }),
      viewerRule("me"),
      reviewPostRule(),
    ])

    const result = await run({ pr: "7", repo: "other/repo", event: "approve" })
    expect(result.foreign).toBe(true)
    expect(result.repo).toBe("other/repo")
  })
})

describe("reference and argument validation", () => {
  test("an issue URL is refused before any call to GitHub", async () => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    const error = await failure(run({ pr: "https://github.com/octo/hello/issues/7", event: "approve" }))
    expect(error.code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("unknown argument is refused", async () => {
    const installed = use([repositoryRule(), stateRule(), reviewPostRule()])
    const error = await failure(run({ pr: "7", event: "approve", unexpected: true }))
    expect(error.code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
