import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { GraphQLToolError } from "../gh"
import {
  isIssueFieldsMissingError,
  issueFieldValues,
  issueFieldValuesSchema,
  type RawIssueFieldValue,
} from "./issue-fields"

describe("issueFieldValuesSchema", () => {
  test("accepts valid issue fields mapping", () => {
    const fields = {
      Priority: "High",
      Effort: 5,
      "Target date": "2026-12-01",
      Components: ["UI", "API"],
    }
    expect(issueFieldValuesSchema.parse(fields)).toEqual(fields)
  })

  test("refuses invalid field value types", () => {
    expect(issueFieldValuesSchema.safeParse({ Active: true }).success).toBe(false)
    expect(issueFieldValuesSchema.safeParse({ Nested: { a: 1 } }).success).toBe(false)
  })
})

describe("issueFieldValues mapper", () => {
  test("maps each of the five value types", () => {
    const nodes: RawIssueFieldValue[] = [
      {
        __typename: "IssueFieldTextValue",
        field: { name: "Sprint" },
        value: "Sprint 42",
      },
      {
        __typename: "IssueFieldNumberValue",
        field: { name: "Effort" },
        value: 3.5,
      },
      {
        __typename: "IssueFieldDateValue",
        field: { name: "Target date" },
        value: "2026-12-01",
      },
      {
        __typename: "IssueFieldSingleSelectValue",
        field: { name: "Priority" },
        name: "High",
      },
      {
        __typename: "IssueFieldMultiSelectValue",
        field: { name: "Components" },
        options: [{ name: "UI" }, { name: "Backend" }],
      },
    ]

    expect(issueFieldValues({ nodes })).toEqual({
      Sprint: "Sprint 42",
      Effort: 3.5,
      "Target date": "2026-12-01",
      Priority: "High",
      Components: ["UI", "Backend"],
    })
  })

  test("empty connection gives {}", () => {
    expect(issueFieldValues({ nodes: [] })).toEqual({})
    expect(issueFieldValues(null)).toEqual({})
    expect(issueFieldValues(undefined)).toEqual({})
  })

  test("unknown typename is skipped", () => {
    const nodes: RawIssueFieldValue[] = [
      {
        __typename: "IssueFieldUnknownValue",
        field: { name: "Custom" },
        value: "ignored",
      },
      {
        __typename: "IssueFieldNumberValue",
        field: { name: "Points" },
        value: 0,
      },
    ]

    expect(issueFieldValues({ nodes })).toEqual({
      Points: 0,
    })
  })

  test("fields without values or names are omitted", () => {
    const nodes: RawIssueFieldValue[] = [
      {
        __typename: "IssueFieldTextValue",
        field: null,
        value: "no field",
      },
      {
        __typename: "IssueFieldMultiSelectValue",
        field: { name: "EmptyMulti" },
        options: [],
      },
      {
        __typename: "IssueFieldSingleSelectValue",
        field: { name: "EmptySelect" },
        name: null,
      },
    ]

    expect(issueFieldValues({ nodes })).toEqual({})
  })
})

describe("isIssueFieldsMissingError", () => {
  test("detects schema error from GraphQLToolError", () => {
    const error = new GraphQLToolError(
      "github_error",
      "GitHub GraphQL error: Field 'issueFieldValues' doesn't exist on type 'Issue'",
      [{ message: "Field 'issueFieldValues' doesn't exist on type 'Issue'" }],
      null,
    )
    expect(isIssueFieldsMissingError(error)).toBe(true)
  })

  test("detects schema error from generic ToolError", () => {
    const error = new ToolError(
      "github_error",
      `gh failed (exit 1): Field "issueFieldValues" doesn't exist on type "Issue"`,
    )
    expect(isIssueFieldsMissingError(error)).toBe(true)
  })

  test("ignores unrelated errors", () => {
    expect(new ToolError("not_found", "Issue not found")).toSatisfy((e) => !isIssueFieldsMissingError(e))
    expect(
      new GraphQLToolError(
        "forbidden",
        "Resource not accessible by personal access token",
        [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
        null,
      ),
    ).toSatisfy((e) => !isIssueFieldsMissingError(e))
  })
})
