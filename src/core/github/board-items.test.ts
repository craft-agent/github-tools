import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { gqlErrors, gqlReply } from "../../testing/gql"
import { apiCalls, failure } from "../../testing/issue-fixtures"
import {
  ITEMS,
  issueFieldValue,
  itemsPage,
  itemsRule,
  rawDraftContent,
  rawItem,
  statusValue,
} from "../../testing/board-item-fixtures"
import { itemReadRule } from "../../testing/board-write-fixtures"
import { readBoardItem, readBoardItems } from "./board-items"

const ORIGIN = "https://github.com/octo/hello.git"

let repo: TempRepo
let fake: FakeGh | undefined

beforeEach(() => {
  repo = tempRepo(ORIGIN)
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

describe("readBoardItems", () => {
  test("query sent includes ProjectV2ItemIssueFieldValue", async () => {
    const installed = useFake([itemsRule([rawItem("PVTI_1", null)])])
    await readBoardItems("PVT_1", { cwd: repo.dir })
    const calls = apiCalls(installed)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.join(" ")).toContain("ProjectV2ItemIssueFieldValue")
  })

  test("maps each of the five issue field value types under the column name", async () => {
    const values = [
      issueFieldValue("Sprint", { __typename: "IssueFieldTextValue", value: "Sprint 42" }),
      issueFieldValue("Effort", { __typename: "IssueFieldNumberValue", value: 3.5 }),
      issueFieldValue("Target date", { __typename: "IssueFieldDateValue", value: "2026-11-30" }),
      issueFieldValue("Priority", { __typename: "IssueFieldSingleSelectValue", name: "High" }),
      issueFieldValue("Components", {
        __typename: "IssueFieldMultiSelectValue",
        options: [{ name: "UI" }, { name: "API" }],
      }),
      statusValue("In Progress"),
    ]
    useFake([itemsRule([rawItem("PVTI_1", null, values)])])
    const { items } = await readBoardItems("PVT_1", { cwd: repo.dir })
    expect(items[0]!.fields).toEqual({
      Sprint: "Sprint 42",
      Effort: 3.5,
      "Target date": "2026-11-30",
      Priority: "High",
      Components: ["UI", "API"],
      Status: "In Progress",
    })
  })

  test("a node with null or empty issueFieldValue is omitted", async () => {
    const values = [
      issueFieldValue("Unset", null),
      issueFieldValue("EmptySelect", { __typename: "IssueFieldSingleSelectValue", name: null }),
      issueFieldValue("EmptyMulti", { __typename: "IssueFieldMultiSelectValue", options: [] }),
      issueFieldValue("Unknown", { __typename: "IssueFieldFutureValue", value: "future" } as never),
      statusValue("Done"),
    ]
    useFake([itemsRule([rawItem("PVTI_1", null, values)])])
    const { items } = await readBoardItems("PVT_1", { cwd: repo.dir })
    expect(items[0]!.fields).toEqual({
      Status: "Done",
    })
  })

  test("fallback re-runs without ProjectV2ItemIssueFieldValue on schema error", async () => {
    const fallbackItem = rawItem("PVTI_1", null, [statusValue("Done")])
    const installed = useFake([
      {
        match: "ProjectV2ItemIssueFieldValue",
        stdout: gqlErrors([
          {
            type: "undefinedType",
            message: "No such type ProjectV2ItemIssueFieldValue, so it can't be a fragment condition",
          },
        ]),
      },
      {
        match: ITEMS,
        stdout: itemsPage([fallbackItem]),
      },
    ])

    const { items } = await readBoardItems("PVT_1", { cwd: repo.dir })
    expect(items).toHaveLength(1)
    expect(items[0]!.fields).toEqual({ Status: "Done" })

    const calls = apiCalls(installed)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.join(" ")).toContain("ProjectV2ItemIssueFieldValue")
    expect(calls[1]!.join(" ")).not.toContain("ProjectV2ItemIssueFieldValue")
  })

  test("unrelated error is not retried", async () => {
    useFake([
      {
        match: "ProjectV2ItemIssueFieldValue",
        stdout: gqlErrors([
          {
            type: "undefinedType",
            message: "No such type Foo, so it can't be a fragment condition",
          },
        ]),
      },
    ])

    const error = await failure(readBoardItems("PVT_1", { cwd: repo.dir }))
    expect(error.message).toContain("No such type Foo")
  })
})

describe("readBoardItem", () => {
  test("query sent includes ProjectV2ItemIssueFieldValue", async () => {
    const item = rawItem("PVTI_1", rawDraftContent("Draft 1"), [
      issueFieldValue("Target date", { __typename: "IssueFieldDateValue", value: "2026-11-30" }),
    ])
    const installed = useFake([itemReadRule("PVTI_1", item)])

    const result = await readBoardItem("PVTI_1", { cwd: repo.dir })
    expect(result).not.toBeNull()
    expect(result?.item.fields).toEqual({ "Target date": "2026-11-30" })

    const calls = apiCalls(installed)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.join(" ")).toContain("ProjectV2ItemIssueFieldValue")
  })

  test("fallback re-runs without ProjectV2ItemIssueFieldValue on schema error", async () => {
    const fallbackItem = rawItem("PVTI_1", null, [statusValue("Done")])
    const installed = useFake([
      {
        match: "ProjectV2ItemIssueFieldValue",
        stdout: gqlErrors([
          {
            type: "undefinedType",
            message: "No such type ProjectV2ItemIssueFieldValue, so it can't be a fragment condition",
          },
        ]),
      },
      {
        match: "ProjectV2Item",
        stdout: gqlReply({ node: fallbackItem }),
      },
    ])

    const result = await readBoardItem("PVTI_1", { cwd: repo.dir })
    expect(result).not.toBeNull()
    expect(result?.item.fields).toEqual({ Status: "Done" })

    const calls = apiCalls(installed)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.join(" ")).toContain("ProjectV2ItemIssueFieldValue")
    expect(calls[1]!.join(" ")).not.toContain("ProjectV2ItemIssueFieldValue")
  })

  test("returns null when item is not found", async () => {
    useFake([{ match: "ProjectV2Item", stdout: gqlReply({ node: null }) }])
    const result = await readBoardItem("PVTI_999", { cwd: repo.dir })
    expect(result).toBeNull()
  })
})
