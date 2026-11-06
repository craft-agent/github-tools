import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  DETAIL,
  EXPECTED_PULL_REQUEST,
  apiCalls,
  detailRule,
  failure,
  rawPullRequest,
  variable,
} from "../../testing/pull-request-fixtures"
import { invoke } from "../tool"
import { prRead } from "./read"

let repo: TempRepo
let fake: FakeGh | undefined
beforeEach(() => {
  repo = tempRepo("https://github.com/octo/hello.git")
})
afterEach(() => {
  fake?.restore()
  fake = undefined
  repo.cleanup()
})
function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}
const read = (args: Record<string, unknown>) => invoke(prRead, args, { cwd: repo.dir })

test("maps a pull request in full from one query", async () => {
  const installed = useFake([detailRule()])
  expect(await read({ method: "view", pr: "7" })).toEqual({ repo: "octo/hello", pull_request: EXPECTED_PULL_REQUEST })
  expect(apiCalls(installed)).toHaveLength(1)
  expect(variable(apiCalls(installed)[0]!, "comments")).toBe("5")
  const query = variable(apiCalls(installed)[0]!, "query")!
  expect(query).toContain("lastCommit: commits(last:1)")
  expect(query).toContain("isRequired(pullRequestNumber:$n)")
  expect(query).toContain("stack{number size} stackEntry{position}")
})

test("merged state and a deleted head repository", async () => {
  useFake([detailRule(rawPullRequest({ state: "MERGED", headRepository: null, mergedAt: "2026-11-02T00:00:00Z" }))])
  const result = await read({ method: "view", pr: "7" })
  expect(result.pull_request?.state).toBe("merged")
  expect(result.pull_request?.head_repo).toBeNull()
  expect(result.pull_request?.merged_at).toBe("2026-11-02T00:00:00Z")
})

test("nullable fields and absent connections", async () => {
  useFake([
    detailRule(
      rawPullRequest({
        body: null,
        author: null,
        milestone: null,
        reviewDecision: null,
        autoMergeRequest: null,
        stack: null,
        stackEntry: null,
        reviewThreads: {
          totalCount: 1,
          nodes: [{ isResolved: false, isOutdated: false, path: "a", line: 1, comments: { nodes: [] } }],
        },
        lastCommit: null,
        comments: { totalCount: 9 },
      }),
    ),
  ])
  const pull = (await read({ method: "view", pr: "7" })).pull_request!
  expect(pull.body).toBe("")
  expect(pull.author).toBeNull()
  expect(pull.milestone).toBeNull()
  expect(pull.auto_merge).toBeNull()
  expect(pull.stack).toBeNull()
  expect(pull.review_decision).toBeNull()
  expect(pull.unresolved_threads).toEqual([{ path: "a", line: 1, outdated: false, author: null, body: "", url: null }])
  expect(pull.unresolved_threads_truncated).toBe(false)
  expect(pull.checks.overall).toBe("none")
  expect(pull.comments).toEqual([])
})

test("comments zero disables nodes but preserves the count", async () => {
  const installed = useFake([detailRule(rawPullRequest({ comments: { totalCount: 9 } }))])
  const result = await read({ method: "view", pr: "7", comments: 0 })
  expect(result.pull_request?.comments).toEqual([])
  expect(result.pull_request?.comment_count).toBe(9)
  expect(variable(apiCalls(installed)[0]!, "withComments")).toBe("false")
  expect(variable(apiCalls(installed)[0]!, "comments")).toBe("1")
})

test.each([false, true])("not_found wording, GraphQL error: %p", async (graphqlError) => {
  useFake([
    graphqlError
      ? { match: DETAIL, stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve" }]) }
      : detailRule(null),
  ])
  const error = await failure(read({ method: "view", pr: "99" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe(
    "Pull request octo/hello#99 was not found: it does not exist, is an issue, or the viewer cannot see it.",
  )
})

test("an issue URL is refused before a GitHub read", async () => {
  const installed = useFake([])
  expect((await failure(read({ method: "view", pr: "https://github.com/octo/hello/issues/7" }))).code).toBe(
    "invalid_argument",
  )
  expect(apiCalls(installed)).toHaveLength(0)
})

test.each([undefined, "", "   "])("missing pr %p", async (pr) => {
  const error = await failure(read({ method: "view", pr }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('method "view" needs `pr`: 12, #12, owner/repo#12 or its URL.')
})

test.each(["state", "author", "assignee", "base", "head", "label", "query", "limit"])(
  "view refuses %s",
  async (name) => {
    const error = await failure(
      read({ method: "view", pr: "7", [name]: name === "limit" ? 5 : name === "state" ? "open" : "x" }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(`"${name}" is an argument of method "list", not "view"; leave it out.`)
  },
)

test.each([-1, 51, 1.5])("invalid comments %p", async (comments) => {
  expect((await failure(read({ method: "view", pr: "7", comments }))).code).toBe("invalid_argument")
})
