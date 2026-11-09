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
import { FIELDS, HEADING, issueFieldsRule, issueHeadingRule } from "../../testing/write-fixtures"
import type { ToolError } from "../errors"
import { parseRepo } from "../refs"
import {
  issueBriefSchema,
  issueDetailSchema,
  readIssue,
  readIssueFields,
  readIssueHeading,
  readSubIssues,
  searchIssues,
  stateWord,
} from "./issues"

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

  test("every state is a lower-case word: the issue, its reason, its relations and its pull requests", async () => {
    useFake([
      detailRule(
        rawIssue({
          state: "CLOSED",
          stateReason: "DUPLICATE",
          parent: brief(1, { state: "CLOSED" }),
          closedByPullRequestsReferences: {
            nodes: [
              { number: 20, title: "A", url: "u", state: "MERGED", merged: true },
              { number: 21, title: "B", url: "u", state: "OPEN" },
              { number: 22, title: "C", url: "u", state: "CLOSED" },
            ],
          },
        }),
      ),
      dependenciesRule(),
    ])
    const issue = await readIssue(REF, { comments: 0 }, CTX)
    expect([issue.state, issue.state_reason, issue.parent?.state]).toEqual(["closed", "duplicate", "closed"])
    expect(issue.sub_issues.map((sub) => sub.state)).toEqual(["open", "closed"])
    expect(issue.blocked_by.map((blocker) => blocker.state)).toEqual(["open"])
    expect(issue.closing_pull_requests.map((pull) => pull.state)).toEqual(["merged", "open", "closed"])
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

  test("the detail query sent includes the issueFieldValues fragment", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    await readIssue(REF, { comments: 5 }, CTX)
    const detailCall = apiCalls(installed).find((args) => args.join(" ").includes(DETAIL))
    expect(variable(detailCall!, "query")).toContain("issueFieldValues(first:25)")
  })

  test("returns the issue fields mapped by field name", async () => {
    useFake([
      detailRule(
        rawIssue({
          issueFieldValues: {
            nodes: [
              {
                __typename: "IssueFieldSingleSelectValue",
                field: { name: "Priority" },
                name: "High",
              },
              {
                __typename: "IssueFieldNumberValue",
                field: { name: "Effort" },
                value: 8,
              },
            ],
          },
        }),
      ),
      dependenciesRule(),
    ])
    const issue = await readIssue(REF, { comments: 5 }, CTX)
    expect(issue.issue_fields).toEqual({ Priority: "High", Effort: 8 })
  })

  test("a schema error on issueFieldValues re-runs without the fragment and returns issue_fields: null", async () => {
    const installed = useFake([
      {
        match: DETAIL,
        stdout: gqlErrors([{ message: "Field 'issueFieldValues' doesn't exist on type 'Issue'" }]),
        times: 1,
      },
      detailRule(rawIssue()),
      dependenciesRule(),
    ])
    const issue = await readIssue(REF, { comments: 5 }, CTX)
    expect(issue.issue_fields).toBeNull()
    const calls = apiCalls(installed).filter((args) => args.join(" ").includes(DETAIL))
    expect(calls).toHaveLength(2)
    expect(variable(calls[0]!, "query")).toContain("issueFieldValues(first:25)")
    expect(variable(calls[1]!, "query")).not.toContain("issueFieldValues(first:25)")
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

  test("the search query sent includes the issueFieldValues fragment", async () => {
    const installed = useFake([searchRule()])
    await searchIssues(QUERY, 30, CTX)
    const call = apiCalls(installed).find((args) => args.join(" ").includes("search(type:ISSUE"))
    expect(variable(call!, "query")).toContain("issueFieldValues(first:25)")
  })

  test("a schema error on issueFieldValues re-runs without the fragment and returns issue_fields: null on rows", async () => {
    const installed = useFake([
      {
        match: SEARCH,
        stdout: gqlErrors([{ message: "Field 'issueFieldValues' doesn't exist on type 'Issue'" }]),
        times: 1,
      },
      searchRule([rawRow(1)]),
    ])
    const { issues } = await searchIssues(QUERY, 30, CTX)
    expect(issues[0]?.issue_fields).toBeNull()
    const calls = apiCalls(installed).filter((args) => args.join(" ").includes("search(type:ISSUE"))
    expect(calls).toHaveLength(2)
    expect(variable(calls[0]!, "query")).toContain("issueFieldValues(first:25)")
    expect(variable(calls[1]!, "query")).not.toContain("issueFieldValues(first:25)")
  })
})

describe("readSubIssues", () => {
  test("reads the parent and its sub-issues as rows, in GitHub's order", async () => {
    const installed = useFake([subIssuesRule([rawRow(4), rawRow(2, { state: "CLOSED" })])])
    const read = await readSubIssues(REF, CTX)
    expect(read.parent).toEqual(issueBrief(1, { title: "Epic" }))
    expect(read.issues.map((issue) => [issue.number, issue.state])).toEqual([
      [4, "open"],
      [2, "closed"],
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

  test("the sub-issues query sent includes the issueFieldValues fragment", async () => {
    const installed = useFake([subIssuesRule([rawRow(1)])])
    await readSubIssues(REF, CTX)
    const call = apiCalls(installed).find((args) => new RegExp(SUB_ISSUES).test(args.join(" ")))
    expect(variable(call!, "query")).toContain("issueFieldValues(first:25)")
  })

  test("a schema error on issueFieldValues re-runs without the fragment and returns issue_fields: null on rows", async () => {
    const installed = useFake([
      {
        match: SUB_ISSUES,
        stdout: gqlErrors([{ message: "Field 'issueFieldValues' doesn't exist on type 'Issue'" }]),
        times: 1,
      },
      subIssuesRule([rawRow(4)]),
    ])
    const read = await readSubIssues(REF, CTX)
    expect(read.issues[0]?.issue_fields).toBeNull()
    const calls = apiCalls(installed).filter((args) => new RegExp(SUB_ISSUES).test(args.join(" ")))
    expect(calls).toHaveLength(2)
    expect(variable(calls[0]!, "query")).toContain("issueFieldValues(first:25)")
    expect(variable(calls[1]!, "query")).not.toContain("issueFieldValues(first:25)")
  })
})

describe("stateWord", () => {
  test("lower-cases GitHub's enum values, and keeps an absent one null", () => {
    expect(stateWord("NOT_PLANNED")).toBe("not_planned")
    expect(stateWord("FUTURE_VALUE")).toBe("future_value")
    expect(stateWord(null)).toBeNull()
    expect(stateWord(undefined)).toBeNull()
  })
})

describe("readIssueFields", () => {
  test("reads the id, the state, the reason, the body and the labels in one query", async () => {
    const installed = useFake([
      issueFieldsRule({
        id: "I_7",
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        body: "Text",
        labels: ["bug", "type:bug"],
      }),
    ])
    expect(await readIssueFields(REF, CTX)).toEqual({
      id: "I_7",
      state: "closed",
      state_reason: "not_planned",
      body: "Text",
      labels: ["bug", "type:bug"],
    })
    expect(apiCalls(installed)).toHaveLength(1)
    expect(variable(apiCalls(installed)[0]!, "n")).toBe("12")
  })

  test("a reason GitHub adds later is lower-cased, not dropped", async () => {
    useFake([issueFieldsRule({ state: "CLOSED", stateReason: "SOMETHING_NEW" })])
    expect((await readIssueFields(REF, CTX)).state_reason).toBe("something_new")
  })

  test("a missing body is empty and a missing reason is null", async () => {
    useFake([
      {
        match: FIELDS,
        stdout: gqlReply({ repository: { issue: { id: "I_1", state: "OPEN", body: null, labels: null } } }),
      },
    ])
    expect(await readIssueFields(REF, CTX)).toEqual({
      id: "I_1",
      state: "open",
      state_reason: null,
      body: "",
      labels: [],
    })
  })

  test("an issue that does not exist is not_found", async () => {
    useFake([{ match: FIELDS, stdout: gqlReply({ repository: { issue: null } }) }])
    const error = await failure(readIssueFields(REF, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#12")
  })
})

describe("readIssueHeading", () => {
  test("reads the id, the title, the state and the reason in one query", async () => {
    const installed = useFake([
      issueHeadingRule({ id: "I_7", title: "Crash", state: "CLOSED", stateReason: "NOT_PLANNED" }),
    ])
    expect(await readIssueHeading(REF, CTX)).toEqual({
      id: "I_7",
      title: "Crash",
      state: "closed",
      state_reason: "not_planned",
    })
    expect(apiCalls(installed)).toHaveLength(1)
    expect(variable(apiCalls(installed)[0]!, "n")).toBe("12")
  })

  test("a missing reason is null", async () => {
    useFake([issueHeadingRule()])
    expect(await readIssueHeading(REF, CTX)).toEqual({
      id: "I_12",
      title: "Crash on save",
      state: "open",
      state_reason: null,
    })
  })

  test("an issue that does not exist is not_found", async () => {
    useFake([{ match: HEADING, stdout: gqlReply({ repository: { issue: null } }) }])
    const error = await failure(readIssueHeading(REF, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#12")
  })
})
