import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors, gqlReply } from "../../testing/gql"
import {
  DEPENDENCIES,
  DETAIL,
  EXPECTED_ISSUE,
  SEARCH,
  SUB_ISSUES,
  apiCalls,
  brief,
  dependenciesRule,
  detailRule,
  failure,
  issueBrief,
  issueRow,
  rawIssue,
  rawRow,
  searchPage,
  searchRule,
  subIssuesRule,
  variable,
} from "../../testing/issue-fixtures"
import type { ToolError } from "../errors"
import { parseRepo } from "../refs"
import { issueBriefSchema, issueDetailSchema, readIssue, readSubIssues, searchIssues } from "./issues"

const CTX = { cwd: process.cwd() }
const REF = { repo: parseRepo("octo/hello"), number: 12 }

let fake: FakeGh | undefined

afterEach(() => {
  fake?.restore()
  fake = undefined
})

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

describe("issueBriefSchema", () => {
  test("accepts a brief and refuses one without its repository", () => {
    expect(issueBriefSchema.parse(issueBrief(3))).toEqual(issueBrief(3))
    const { repo: _repo, ...withoutRepo } = issueBrief(3)
    expect(issueBriefSchema.safeParse(withoutRepo).success).toBe(false)
  })
})

describe("issueDetailSchema", () => {
  test("accepts an issue in full", () => {
    expect(issueDetailSchema.parse(EXPECTED_ISSUE)).toEqual(EXPECTED_ISSUE)
  })

  test("accepts an issue with nothing optional set", () => {
    const bare = {
      ...EXPECTED_ISSUE,
      state_reason: null,
      author: null,
      milestone: null,
      kind: null,
      issue_type: null,
      parent: null,
      dependencies_error: "not_found: gone",
    }
    expect(issueDetailSchema.parse(bare)).toEqual(bare)
  })

  test.each(Object.keys(EXPECTED_ISSUE))("%s is required, even where it may be null", (key) => {
    const { [key as keyof typeof EXPECTED_ISSUE]: _left, ...without } = EXPECTED_ISSUE
    expect(issueDetailSchema.safeParse(without).success).toBe(false)
  })

  test("a count that is not a whole number is refused", () => {
    expect(issueDetailSchema.safeParse({ ...EXPECTED_ISSUE, comment_count: 1.5 }).success).toBe(false)
  })
})

describe("readIssue", () => {
  test("returns the whole picture of an issue from two reads", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    expect(await readIssue(REF, { comments: 5 }, CTX)).toEqual(EXPECTED_ISSUE)

    const [detail, dependencies] = apiCalls(installed)
    expect(apiCalls(installed)).toHaveLength(2)
    expect(variable(detail!, "owner")).toBe("octo")
    expect(variable(detail!, "name")).toBe("hello")
    expect(variable(detail!, "n")).toBe("12")
    expect(variable(detail!, "comments")).toBe("5")
    expect(variable(detail!, "withComments")).toBe("true")
    expect(variable(dependencies!, "n")).toBe("12")
  })

  test("the kind is the Issue Type's name when there is one, and the issue type is reported as it is", async () => {
    useFake([detailRule(rawIssue({ issueType: { name: "Feature" } })), dependenciesRule()])
    const issue = await readIssue(REF, { comments: 5 }, CTX)
    expect(issue.kind).toBe("feature")
    expect(issue.issue_type).toBe("Feature")
  })

  test("an issue with no relations, branches, boards or progress reads as empty", async () => {
    useFake([
      detailRule(
        rawIssue({
          parent: null,
          milestone: null,
          author: null,
          labels: { nodes: [] },
          subIssues: { nodes: [] },
          subIssuesSummary: null,
          linkedBranches: { nodes: [] },
          closedByPullRequestsReferences: { nodes: [] },
          projectItems: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
        }),
      ),
      {
        match: DEPENDENCIES,
        stdout: gqlReply({ repository: { issue: { blockedBy: { nodes: [] }, blocking: { nodes: [] } } } }),
      },
    ])
    expect(await readIssue(REF, { comments: 5 }, CTX)).toMatchObject({
      parent: null,
      milestone: null,
      author: null,
      kind: null,
      sub_issues: [],
      sub_issue_progress: { total: 0, completed: 0, percent: 0 },
      blocked_by: [],
      blocking: [],
      linked_branches: [],
      closing_pull_requests: [],
      projects: [],
      comments: [],
      comment_count: 0,
    })
  })

  test("a failing dependencies read still returns the issue, saying why they are empty", async () => {
    useFake([
      detailRule(),
      { match: DEPENDENCIES, stdout: gqlErrors([{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }]) },
    ])
    const issue = await readIssue(REF, { comments: 5 }, CTX)
    expect(issue.title).toBe("Crash on save")
    expect(issue.blocked_by).toEqual([])
    expect(issue.blocking).toEqual([])
    expect(issue.dependencies_error).toContain("blockedBy")
  })

  test("dependencies a repository does not allow are reported, not thrown", async () => {
    useFake([
      detailRule(),
      { match: DEPENDENCIES, stdout: gqlErrors([{ type: "FORBIDDEN", message: "Dependencies are disabled" }]) },
    ])
    expect((await readIssue(REF, { comments: 5 }, CTX)).dependencies_error).toContain("forbidden")
  })

  test.each([
    ["rate_limited", { type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    ["unauthenticated", { message: "HTTP 401: Bad credentials" }],
  ])("a %s dependencies read fails the call instead of reading as no dependencies", async (code, entry) => {
    useFake([detailRule(), { match: DEPENDENCIES, stdout: gqlErrors([entry]) }])
    expect((await failure(readIssue(REF, { comments: 5 }, CTX))).code).toBe(code as ToolError["code"])
  })

  test("an issue gone before its dependencies are read is not_found", async () => {
    useFake([detailRule(), { match: DEPENDENCIES, stdout: gqlReply({ repository: { issue: null } }) }])
    expect((await failure(readIssue(REF, { comments: 5 }, CTX))).code).toBe("not_found")
  })

  test("comments: 0 asks for none but still reports the count", async () => {
    const installed = useFake([detailRule(rawIssue({ comments: { totalCount: 9 } })), dependenciesRule()])
    const issue = await readIssue(REF, { comments: 0 }, CTX)
    const detail = apiCalls(installed)[0]!
    expect(variable(detail, "withComments")).toBe("false")
    expect(variable(detail, "comments")).toBe("1")
    expect(issue.comments).toEqual([])
    expect(issue.comment_count).toBe(9)
  })

  test("asks for as many comments as given", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    await readIssue(REF, { comments: 50 }, CTX)
    expect(variable(apiCalls(installed)[0]!, "comments")).toBe("50")
  })

  test("an issue that does not exist is not_found, whether GitHub answers with an error or with null", async () => {
    useFake([
      {
        match: DETAIL,
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }], {
          repository: { issue: null },
        }),
      },
    ])
    const error = await failure(readIssue({ ...REF, number: 99 }, { comments: 5 }, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#99")
    fake?.restore()

    useFake([detailRule(null)])
    expect((await failure(readIssue({ ...REF, number: 99 }, { comments: 5 }, CTX))).code).toBe("not_found")
  })
})

describe("searchIssues", () => {
  const QUERY = "repo:octo/hello is:issue state:open"

  test("sends the query as it is, with a page as big as the limit up to 100", async () => {
    const installed = useFake([searchRule()])
    await searchIssues(QUERY, 5, CTX)
    await searchIssues(QUERY, 100, CTX)
    const [small, big] = apiCalls(installed)
    expect(variable(small!, "q")).toBe(QUERY)
    expect(variable(small!, "first")).toBe("5")
    expect(variable(big!, "first")).toBe("100")
  })

  test("rows carry the kind, labels, assignees, milestone, parent and progress", async () => {
    useFake([
      searchRule([
        rawRow(3, {
          issueType: { name: "Task" },
          labels: { nodes: [{ name: "ui" }] },
          assignees: { nodes: [{ login: "bob" }, { login: "carol" }] },
          milestone: { title: "v1" },
          parent: brief(1),
          subIssuesSummary: { total: 4, completed: 1, percentCompleted: 25 },
        }),
        rawRow(2, { labels: { nodes: [{ name: "type:Bug" }] } }),
      ]),
    ])
    const { issues, truncated } = await searchIssues(QUERY, 30, CTX)
    expect(truncated).toBe(false)
    expect(issues).toEqual([
      issueRow(3, {
        kind: "task",
        labels: ["ui"],
        assignees: ["bob", "carol"],
        milestone: "v1",
        parent: issueBrief(1),
        sub_issue_progress: { total: 4, completed: 1, percent: 25 },
      }),
      issueRow(2, { kind: "bug", labels: ["type:Bug"] }),
    ])
  })

  test("a hit that is not an issue is skipped", async () => {
    useFake([searchRule([{}, rawRow(2), null])])
    expect((await searchIssues(QUERY, 30, CTX)).issues.map((issue) => issue.number)).toEqual([2])
  })

  test("walks the pages up to the limit and is not truncated when the search ran out", async () => {
    const installed = useFake([
      { match: SEARCH, stdout: searchPage([rawRow(1), rawRow(2)], "c1"), times: 1 },
      { match: SEARCH, stdout: searchPage([rawRow(3)]) },
    ])
    const { issues, truncated } = await searchIssues(QUERY, 30, CTX)
    expect(issues.map((issue) => issue.number)).toEqual([1, 2, 3])
    expect(truncated).toBe(false)
    expect(apiCalls(installed).map((args) => variable(args, "after"))).toEqual(["null", "c1"])
  })

  test("is truncated when more matched than the limit", async () => {
    useFake([{ match: SEARCH, stdout: searchPage([rawRow(1), rawRow(2)], "c1") }])
    const { issues, truncated } = await searchIssues(QUERY, 2, CTX)
    expect(issues.map((issue) => issue.number)).toEqual([1, 2])
    expect(truncated).toBe(true)
  })

  test("is truncated when a page holds more than the limit", async () => {
    useFake([searchRule([rawRow(1), rawRow(2), rawRow(3)])])
    const { issues, truncated } = await searchIssues(QUERY, 2, CTX)
    expect(issues).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  test("a search GitHub refuses fails with GitHub's text", async () => {
    useFake([{ match: SEARCH, stdout: gqlErrors([{ message: "The listed users cannot be searched" }]) }])
    expect((await failure(searchIssues(QUERY, 30, CTX))).message).toContain("cannot be searched")
  })
})

describe("readSubIssues", () => {
  test("reads the parent and its sub-issues as rows, in GitHub's order", async () => {
    const installed = useFake([subIssuesRule([rawRow(4), rawRow(2, { state: "CLOSED" })])])
    const read = await readSubIssues(REF, CTX)
    expect(read.parent).toEqual(issueBrief(1, { title: "Epic" }))
    expect(read.issues.map((issue) => [issue.number, issue.state])).toEqual([
      [4, "OPEN"],
      [2, "CLOSED"],
    ])
    expect(read.more).toBe(false)
    expect(variable(apiCalls(installed)[0]!, "n")).toBe("12")
  })

  test("says when GitHub holds more sub-issues than it returned", async () => {
    useFake([subIssuesRule([rawRow(2)], true)])
    expect((await readSubIssues(REF, CTX)).more).toBe(true)
  })

  test("a parent that does not exist is not_found", async () => {
    useFake([{ match: SUB_ISSUES, stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve" }]) }])
    const error = await failure(readSubIssues(REF, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#12")
  })
})
