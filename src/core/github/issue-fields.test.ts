import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import {
  ISSUE_FIELD_NODES,
  ISSUE_FIELD_MUTATION,
  issueFieldDefinitionsRule,
  issueFieldValuesRule,
  issueFieldsSetRule,
  sent,
} from "../../testing/write-fixtures"
import { ToolError } from "../errors"
import { GraphQLToolError } from "../gh"
import { parseRepo } from "../refs"
import {
  isIssueFieldsMissingError,
  issueFieldValueOf,
  issueFieldValues,
  issueFieldValuesSchema,
  planIssueFieldWrites,
  readIssueFieldDefinitions,
  readIssueFieldValuesById,
  writeIssueFields,
  type IssueFieldDefinition,
  type RawIssueFieldValue,
} from "./issue-fields"

const CTX = { cwd: process.cwd() }
const REPO = parseRepo("octo/hello")

let fake: FakeGh | undefined

afterEach(() => {
  fake?.restore()
  fake = undefined
})

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

const DEFINITIONS: IssueFieldDefinition[] = [
  {
    id: "IF_priority",
    name: "Priority",
    type: "single_select",
    options: [
      { id: "IFO_high", name: "High" },
      { id: "IFO_low", name: "Low" },
    ],
  },
  { id: "IF_effort", name: "Effort", type: "number", options: [] },
  { id: "IF_target", name: "Target date", type: "date", options: [] },
  { id: "IF_sprint", name: "Sprint", type: "text", options: [] },
  {
    id: "IF_components",
    name: "Components",
    type: "multi_select",
    options: [
      { id: "IFO_ui", name: "UI" },
      { id: "IFO_api", name: "API" },
    ],
  },
]

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    return (error as ToolError).message
  }
  throw new Error("expected the call to be refused")
}

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
  test("issueFieldValueOf extracts value per type or undefined", () => {
    expect(issueFieldValueOf({ __typename: "IssueFieldTextValue", value: "hello" })).toBe("hello")
    expect(issueFieldValueOf({ __typename: "IssueFieldNumberValue", value: 42 })).toBe(42)
    expect(issueFieldValueOf({ __typename: "IssueFieldDateValue", value: "2026-11-30" })).toBe("2026-11-30")
    expect(issueFieldValueOf({ __typename: "IssueFieldSingleSelectValue", name: "High" })).toBe("High")
    expect(
      issueFieldValueOf({ __typename: "IssueFieldMultiSelectValue", options: [{ name: "A" }, { name: "B" }] }),
    ).toEqual(["A", "B"])
    expect(issueFieldValueOf({ __typename: "IssueFieldMultiSelectValue", options: [] })).toBeUndefined()
    expect(issueFieldValueOf({ __typename: "IssueFieldSingleSelectValue", name: null })).toBeUndefined()
    expect(issueFieldValueOf({ __typename: "Unknown", value: "foo" })).toBeUndefined()
    expect(issueFieldValueOf(null)).toBeUndefined()
    expect(issueFieldValueOf(undefined)).toBeUndefined()
  })

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

  test("detects issueFields missing on Repository", () => {
    const message = "Field 'issueFields' doesn't exist on type 'Repository'"
    expect(isIssueFieldsMissingError(new GraphQLToolError("github_error", message, [{ message }], null))).toBe(true)
    expect(isIssueFieldsMissingError(new ToolError("github_error", message))).toBe(true)
  })

  test("detects isIssueField missing on ProjectV2Field", () => {
    const message = "Field 'isIssueField' doesn't exist on type 'ProjectV2Field'"
    expect(isIssueFieldsMissingError(new GraphQLToolError("github_error", message, [{ message }], null))).toBe(true)
    expect(isIssueFieldsMissingError(new ToolError("github_error", message))).toBe(true)
  })

  test("detects ProjectV2ItemIssueFieldValue missing from schema", () => {
    const message = "No such type ProjectV2ItemIssueFieldValue, so it can't be a fragment condition"
    expect(isIssueFieldsMissingError(new GraphQLToolError("github_error", message, [{ message }], null))).toBe(true)
    expect(isIssueFieldsMissingError(new ToolError("github_error", message))).toBe(true)
  })

  test("detects ProjectV2IssueFieldValues missing from schema", () => {
    const message = "No such type ProjectV2IssueFieldValues, so it can't be a fragment condition"
    expect(isIssueFieldsMissingError(new GraphQLToolError("github_error", message, [{ message }], null))).toBe(true)
    expect(isIssueFieldsMissingError(new ToolError("github_error", message))).toBe(true)
  })

  test("ignores unrelated missing type errors", () => {
    const message = "No such type Foo, so it can't be a fragment condition"
    expect(isIssueFieldsMissingError(new GraphQLToolError("github_error", message, [{ message }], null))).toBe(false)
    expect(isIssueFieldsMissingError(new ToolError("github_error", message))).toBe(false)
  })
})

describe("readIssueFieldDefinitions", () => {
  test("reads the fields of an organization with their types, ids and options", async () => {
    const installed = useFake([issueFieldDefinitionsRule()])
    expect(await readIssueFieldDefinitions(REPO, CTX)).toEqual(DEFINITIONS)
    expect(sent(installed)).toHaveLength(1)
  })

  test("a field of a type this code does not know is left out", async () => {
    useFake([
      issueFieldDefinitionsRule([
        ...ISSUE_FIELD_NODES.slice(1, 2),
        { __typename: "IssueFieldFuture", id: "IF_x", name: "Future", dataType: "HOLOGRAM" },
      ]),
    ])
    expect((await readIssueFieldDefinitions(REPO, CTX)).map((field) => field.name)).toEqual(["Effort"])
  })

  test("a personal account's repository has none", async () => {
    useFake([issueFieldDefinitionsRule(null)])
    expect(await readIssueFieldDefinitions(REPO, CTX)).toEqual([])
  })

  test("a GitHub without issue fields has none", async () => {
    const message = "Field 'issueFields' doesn't exist on type 'Repository'"
    useFake([{ match: "issueFields", stdout: gqlErrors([{ type: "undefinedField", message }]) }])
    expect(await readIssueFieldDefinitions(REPO, CTX)).toEqual([])
  })

  test("another failure is thrown", async () => {
    useFake([{ match: "issueFields", stderr: "HTTP 500", code: 1 }])
    await expect(readIssueFieldDefinitions(REPO, CTX)).rejects.toBeInstanceOf(ToolError)
  })
})

describe("planIssueFieldWrites", () => {
  const plan = (values: Record<string, string | number | string[]>, clear: string[] = []) =>
    planIssueFieldWrites(REPO, DEFINITIONS, values, clear)

  test("turns each type into its input, matching names without regard to case", () => {
    expect(
      plan({
        priority: "high",
        EFFORT: 3,
        "target DATE": "2026-12-01",
        Sprint: "Sprint 4",
        Components: ["ui", "API", "UI"],
      }),
    ).toEqual([
      { fieldId: "IF_priority", singleSelectOptionId: "IFO_high" },
      { fieldId: "IF_effort", numberValue: 3 },
      { fieldId: "IF_target", dateValue: "2026-12-01" },
      { fieldId: "IF_sprint", textValue: "Sprint 4" },
      { fieldId: "IF_components", multiSelectOptionIds: ["IFO_ui", "IFO_api"] },
    ])
  })

  test("a number may be a numeric string, and a multi select one name", () => {
    expect(plan({ Effort: " -2.5 ", Components: "api" })).toEqual([
      { fieldId: "IF_effort", numberValue: -2.5 },
      { fieldId: "IF_components", multiSelectOptionIds: ["IFO_api"] },
    ])
  })

  test("clearing is a delete, once per field", () => {
    expect(plan({ Effort: 1 }, ["priority", "Priority", "Sprint"])).toEqual([
      { fieldId: "IF_effort", numberValue: 1 },
      { fieldId: "IF_priority", delete: true },
      { fieldId: "IF_sprint", delete: true },
    ])
  })

  test("nothing to set or clear gives no writes, even without definitions", () => {
    expect(planIssueFieldWrites(REPO, [], {}, [])).toEqual([])
  })

  test("a repository without issue fields refuses both setting and clearing", () => {
    expect(refusal(() => planIssueFieldWrites(REPO, [], { Priority: "High" }, []))).toContain(
      "octo/hello has no issue fields",
    )
    expect(refusal(() => planIssueFieldWrites(REPO, [], {}, ["Priority"]))).toContain("octo/hello has no issue fields")
  })

  test("an unknown field names the fields", () => {
    const message = refusal(() => plan({ Severity: "High" }))
    expect(message).toContain('no issue field "Severity"')
    expect(message).toContain('"Priority", "Effort", "Target date", "Sprint", "Components"')
    expect(refusal(() => plan({}, ["Severity"]))).toContain('no issue field "Severity"')
  })

  test("an unknown option names the options", () => {
    expect(refusal(() => plan({ Priority: "Urgent" }))).toContain('no option "Urgent". Options: "High", "Low"')
    expect(refusal(() => plan({ Components: ["UI", "Docs"] }))).toContain('no option "Docs". Options: "UI", "API"')
  })

  test("a field named twice is refused", () => {
    expect(refusal(() => plan({ Priority: "High", priority: "Low" }))).toContain('names "Priority" twice')
    expect(refusal(() => plan({ Priority: "High" }, ["priority"]))).toContain('"Priority" is in both')
  })

  test("a text takes a string, not a number", () => {
    expect(refusal(() => plan({ Sprint: 4 }))).toContain('"Sprint" takes text as text; got the number 4')
  })

  test("a number must be a number", () => {
    expect(refusal(() => plan({ Effort: "lots" }))).toContain('"Effort" takes a number; got "lots"')
    expect(refusal(() => plan({ Effort: "NaN" }))).toContain('"Effort" takes a number')
  })

  test("a date must be a real YYYY-MM-DD", () => {
    expect(refusal(() => plan({ "Target date": "2026-02-30" }))).toContain('"Target date" takes a date as YYYY-MM-DD')
    expect(refusal(() => plan({ "Target date": "12/01/2026" }))).toContain("YYYY-MM-DD")
    expect(refusal(() => plan({ "Target date": 20261201 }))).toContain('"Target date" takes a date as text')
  })

  test("a single select takes one option, not a list", () => {
    const message = refusal(() => plan({ Priority: ["High"] }))
    expect(message).toContain('"Priority" takes one option name, not a list')
    expect(message).toContain('Options: "High", "Low"')
  })

  test("a list is refused for the other single-valued types", () => {
    expect(refusal(() => plan({ Effort: ["1"] }))).toContain('"Effort" takes a number, not a list')
    expect(refusal(() => plan({ Sprint: ["a"] }))).toContain('"Sprint" takes text, not a list')
  })

  test("a multi select needs an option and points to clearing", () => {
    expect(refusal(() => plan({ Components: [] }))).toContain("clear_issue_fields")
  })
})

describe("writeIssueFields", () => {
  test("sets and clears in one mutation with each value in its input", async () => {
    const installed = useFake([issueFieldsSetRule()])
    await writeIssueFields(
      "I_12",
      [
        { fieldId: "IF_sprint", textValue: 'Say "hi"' },
        { fieldId: "IF_effort", numberValue: 2.5 },
        { fieldId: "IF_target", dateValue: "2026-12-01" },
        { fieldId: "IF_priority", singleSelectOptionId: "IFO_high" },
        { fieldId: "IF_components", multiSelectOptionIds: ["IFO_ui", "IFO_api"] },
        { fieldId: "IF_old", delete: true },
      ],
      CTX,
    )
    const calls = sent(installed)
    expect(calls).toHaveLength(1)
    const text = calls[0]!.join(" ")
    expect(text).toContain("issueId:$issueId")
    expect(text).toContain(
      'issueFields:[{fieldId:"IF_sprint",textValue:"Say \\"hi\\""},{fieldId:"IF_effort",numberValue:2.5},{fieldId:"IF_target",dateValue:"2026-12-01"},{fieldId:"IF_priority",singleSelectOptionId:"IFO_high"},{fieldId:"IF_components",multiSelectOptionIds:["IFO_ui","IFO_api"]},{fieldId:"IF_old",delete:true}]',
    )
    expect(calls[0]).toContain("issueId=I_12")
  })

  test("an empty list sends nothing", async () => {
    const installed = useFake([issueFieldsSetRule()])
    await writeIssueFields("I_12", [], CTX)
    expect(sent(installed)).toEqual([])
  })

  test("a failure is thrown with the code GitHub's error maps to", async () => {
    useFake([
      {
        match: ISSUE_FIELD_MUTATION,
        stdout: gqlErrors([{ type: "VALIDATION", message: "Date is invalid" }]),
      },
    ])
    await expect(writeIssueFields("I_12", [{ fieldId: "IF_target", dateValue: "2026-12-01" }], CTX)).rejects.toThrow(
      "Date is invalid",
    )
  })
})

describe("readIssueFieldValuesById", () => {
  test("maps the issue's field values", async () => {
    useFake([
      issueFieldValuesRule([
        { __typename: "IssueFieldSingleSelectValue", field: { name: "Priority" }, name: "High" },
        { __typename: "IssueFieldNumberValue", field: { name: "Effort" }, value: 3 },
      ]),
    ])
    expect(await readIssueFieldValuesById("I_12", CTX)).toEqual({ Priority: "High", Effort: 3 })
  })
})
