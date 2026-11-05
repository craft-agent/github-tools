import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { connection, fieldsRule, viewsRule } from "../../testing/project-fixtures"
import { readBoardFields, readBoardViews } from "./board-fields"

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
      { id: "F1", name: "Title", type: "title" },
      { id: "F2", name: "Estimate", type: "number" },
      {
        id: "F3",
        name: "Status",
        type: "single_select",
        options: [
          { id: "o1", name: "Todo", color: "BLUE", description: "Ready to start" },
          { id: "o2", name: "Done", color: "PURPLE", description: "" },
        ],
      },
      {
        id: "F4",
        name: "Sprint",
        type: "iteration",
        iterations: [{ id: "i1", title: "Sprint 1", start_date: "2026-11-02", duration: 14 }],
      },
      { id: "F5", name: "Linked pull requests", type: "linked_pull_requests" },
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
