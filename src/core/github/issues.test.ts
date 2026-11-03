import { describe, expect, test } from "bun:test"
import { EXPECTED_ISSUE, issueBrief } from "../../testing/issue-fixtures"
import { issueBriefSchema, issueDetailSchema } from "./issues"

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
