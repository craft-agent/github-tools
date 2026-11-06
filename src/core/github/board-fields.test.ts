import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { connection, fieldsRule, viewsRule } from "../../testing/project-fixtures"
import { readBoardFields, readBoardViews, toField } from "./board-fields"

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

describe("toField", () => {
  test("a normal field has issue_field false and takes its options from options", () => {
    expect(
      toField({
        id: "F1",
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: [{ id: "o1", name: "Todo", color: "BLUE", description: null }],
      }),
    ).toEqual({
      id: "F1",
      name: "Status",
      type: "single_select",
      issue_field: false,
      options: [{ id: "o1", name: "Todo", color: "BLUE", description: "" }],
    })
  })

  test("a mirrored single-select takes options from issueField and marks issue_field true", () => {
    expect(
      toField({
        id: "F_priority",
        name: "Priority",
        dataType: "SINGLE_SELECT",
        isIssueField: true,
        options: [],
        issueField: {
          __typename: "IssueFieldSingleSelect",
          options: [
            { id: "IFSSO_1", name: "High", color: "RED", description: "Critical" },
            { id: "IFSSO_2", name: "Low", color: "BLUE", description: null },
          ],
        },
      }),
    ).toEqual({
      id: "F_priority",
      name: "Priority",
      type: "single_select",
      issue_field: true,
      options: [
        { id: "IFSSO_1", name: "High", color: "RED", description: "Critical" },
        { id: "IFSSO_2", name: "Low", color: "BLUE", description: "" },
      ],
    })
  })

  test("a mirrored date column has issue_field true and no options", () => {
    expect(
      toField({
        id: "F_target_date",
        name: "Target date",
        dataType: "DATE",
        isIssueField: true,
        issueField: { __typename: "IssueFieldDate" },
      }),
    ).toEqual({
      id: "F_target_date",
      name: "Target date",
      type: "date",
      issue_field: true,
    })
  })
})

describe("readBoardFields", () => {
  test("reads each field with its type in lower case, its options and its iterations", async () => {
    useFake([
      fieldsRule([
        { __typename: "ProjectV2Field", id: "F1", name: "Title", dataType: "TITLE" },
        { __typename: "ProjectV2Field", id: "F2", name: "Estimate", dataType: "NUMBER" },
        {
          __typename: "ProjectV2SingleSelectField",
          id: "F3",
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: [
            { id: "o1", name: "Todo", color: "BLUE", description: "Ready to start" },
            { id: "o2", name: "Done", color: "PURPLE", description: null },
          ],
        },
        {
          __typename: "ProjectV2IterationField",
          id: "F4",
          name: "Sprint",
          dataType: "ITERATION",
          configuration: { iterations: [{ id: "i1", title: "Sprint 1", startDate: "2026-11-02", duration: 14 }] },
        },
        { __typename: "ProjectV2Field", id: "F5", name: "Linked pull requests", dataType: "LINKED_PULL_REQUESTS" },
        {},
        null,
      ]),
    ])
    expect(await readBoardFields("PVT_1", { cwd: repo.dir })).toEqual([
      { id: "F1", name: "Title", type: "title", issue_field: false },
      { id: "F2", name: "Estimate", type: "number", issue_field: false },
      {
        id: "F3",
        name: "Status",
        type: "single_select",
        issue_field: false,
        options: [
          { id: "o1", name: "Todo", color: "BLUE", description: "Ready to start" },
          { id: "o2", name: "Done", color: "PURPLE", description: "" },
        ],
      },
      {
        id: "F4",
        name: "Sprint",
        type: "iteration",
        issue_field: false,
        iterations: [{ id: "i1", title: "Sprint 1", start_date: "2026-11-02", duration: 14 }],
      },
      { id: "F5", name: "Linked pull requests", type: "linked_pull_requests", issue_field: false },
    ])
  })

  test("walks every page", async () => {
    const field = (id: string) => ({ id, name: id, dataType: "TEXT" })
    useFake([
      {
        match: "fields\\(first:100",
        stdout: JSON.stringify({ data: { node: { fields: connection([field("a")], "c1") } } }),
        times: 1,
      },
      {
        match: "fields\\(first:100",
        stdout: JSON.stringify({ data: { node: { fields: connection([field("b")], null) } } }),
      },
    ])
    expect((await readBoardFields("PVT_1", { cwd: repo.dir })).map((entry) => entry.id)).toEqual(["a", "b"])
  })

  test("query sent includes isIssueField and issueField selections", async () => {
    const installed = useFake([fieldsRule([{ id: "F1", name: "Title", dataType: "TITLE" }])])
    await readBoardFields("PVT_1", { cwd: repo.dir })
    const sent = installed.calls().filter((args) => args[0] !== "--version")[0] ?? []
    expect(sent.join(" ")).toContain("isIssueField")
    expect(sent.join(" ")).toContain("issueField")
  })

  test("on a schema error from an older GitHub Enterprise Server, falls back to query without isIssueField", async () => {
    const errorJson = JSON.stringify({
      errors: [{ message: "Field 'isIssueField' doesn't exist on type 'ProjectV2Field'" }],
    })
    const fallbackField = { id: "F1", name: "Title", dataType: "TITLE" }
    const installed = useFake([
      {
        match: "fields\\(first:100",
        stderr: errorJson,
        code: 1,
        times: 1,
      },
      {
        match: "fields\\(first:100",
        stdout: JSON.stringify({ data: { node: { fields: connection([fallbackField], null) } } }),
      },
    ])
    const fields = await readBoardFields("PVT_1", { cwd: repo.dir })
    expect(fields).toEqual([{ id: "F1", name: "Title", type: "title", issue_field: false }])
    const apiCalls = installed.calls().filter((args) => args[0] !== "--version")
    expect(apiCalls).toHaveLength(2)
    expect(apiCalls[1]?.join(" ")).not.toContain("isIssueField")
  })

  test("other errors throw", async () => {
    useFake([
      {
        match: "fields\\(first:100",
        stderr: "Could not resolve to a node with the global id of 'PVT_1'",
        code: 1,
      },
    ])
    expect(readBoardFields("PVT_1", { cwd: repo.dir })).rejects.toThrow()
  })
})

describe("readBoardViews", () => {
  test("reads each view with its layout as table, board or roadmap", async () => {
    useFake([
      viewsRule([
        { number: 1, name: "Backlog", layout: "TABLE_LAYOUT", filter: "-status:Done" },
        { number: 2, name: "Kanban", layout: "BOARD_LAYOUT", filter: null },
        { number: 3, name: "Roadmap", layout: "ROADMAP_LAYOUT" },
        null,
      ]),
    ])
    expect(await readBoardViews("PVT_1", { cwd: repo.dir })).toEqual([
      { number: 1, name: "Backlog", layout: "table", filter: "-status:Done" },
      { number: 2, name: "Kanban", layout: "board", filter: null },
      { number: 3, name: "Roadmap", layout: "roadmap", filter: null },
    ])
  })
})
