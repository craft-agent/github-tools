import { describe, expect, test } from "bun:test"
import {
  BOARD_FIELD_NODES,
  BOARD_SUMMARY,
  addDraftRule,
  boardWithFields,
  mutationNames,
  mutationsOf,
  setValueRule,
} from "../../testing/board-write-fixtures"
import { failure } from "../../testing/issue-fixtures"
import { octoBoardRules } from "../../testing/project-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { projectItemCreate } from "./item-create"

const { use, run } = writeHarness(projectItemCreate)

const BOARD = { project: "octo/3" }

describe("a draft", () => {
  test("is added with its title and body, and starts as Todo", async () => {
    const installed = use([...boardWithFields(), addDraftRule("PVTI_draft"), setValueRule()])
    expect(await run({ ...BOARD, title: "  Plan the launch ", body: "Notes" })).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_draft",
      fields: { Status: "Todo" },
      errors: {},
    })
    const [add, status, ...others] = mutationsOf(installed)
    expect(others).toEqual([])
    expect(add).toMatchObject({
      name: "addProjectV2DraftIssue",
      vars: { project: "PVT_3", title: "Plan the launch", body: "Notes" },
    })
    expect(status).toMatchObject({ vars: { item: "PVTI_draft", field: "F_status", value: "O_todo" } })
  })

  test("leaves the body out when none is given", async () => {
    const installed = use([...boardWithFields(), addDraftRule("PVTI_draft"), setValueRule()])
    await run({ ...BOARD, title: "Idea" })
    expect(mutationsOf(installed)[0]!.vars).not.toHaveProperty("body")
  })

  test("takes the fields given, and a Status among them wins over Todo", async () => {
    const installed = use([...boardWithFields(), addDraftRule("PVTI_draft"), setValueRule()])
    const result = await run({ ...BOARD, title: "Idea", fields: { status: "done", Estimate: "2" } })
    expect(result.fields).toEqual({ Status: "Done", Estimate: 2 })
    expect(mutationsOf(installed).map(({ vars }) => vars.field)).toEqual([undefined, "F_status", "F_estimate"])
  })

  test("has no default Status on a board without Todo or Status", async () => {
    const noStatus = BOARD_FIELD_NODES.filter((node) => node.name !== "Status")
    const installed = use([...boardWithFields(noStatus), addDraftRule("PVTI_draft"), setValueRule()])
    expect((await run({ ...BOARD, title: "Idea" })).fields).toEqual({})
    expect(mutationNames(installed)).toEqual(["addProjectV2DraftIssue"])
  })

  test("a field that fails to set is listed under errors, and the draft is still returned", async () => {
    use([
      ...boardWithFields(),
      addDraftRule("PVTI_draft"),
      { match: "updateProjectV2ItemFieldValue[\\s\\S]*field=F_notes", stderr: "boom", code: 1 },
      setValueRule(),
    ])
    const result = await run({ ...BOARD, title: "Idea", fields: { Notes: "x" } })
    expect(result.item_id).toBe("PVTI_draft")
    expect(result.fields).toEqual({ Status: "Todo" })
    expect(result.errors).toEqual({ "fields.Notes": "github_error: gh failed (exit 1): boom" })
  })
})

describe("before anything is written", () => {
  test.each([
    ["an unknown field", { Nope: "x" }, 'no field "Nope"'],
    ["an unknown option", { Status: "Blocked" }, 'no option "Blocked"'],
    ["a bad date", { Target: "2026-13-01" }, "YYYY-MM-DD"],
    ["a field of GitHub's own", { Assignees: "bob" }, "GitHub's own"],
  ])("%s is invalid_argument, and no draft is made", async (_, fields, expected) => {
    const installed = use([...boardWithFields(), addDraftRule("PVTI_draft"), setValueRule()])
    const error = await failure(run({ ...BOARD, title: "Idea", fields }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(mutationNames(installed)).toEqual([])
  })

  test("a blank title is invalid_argument", async () => {
    const installed = use([...boardWithFields(), addDraftRule("PVTI_draft")])
    expect((await failure(run({ ...BOARD, title: "  " }))).code).toBe("invalid_argument")
    expect(installed.calls().filter((args) => args[0] !== "--version")).toEqual([])
  })

  test("a board the viewer cannot update is forbidden", async () => {
    const installed = use([...octoBoardRules(3, { viewerCanUpdate: false }), addDraftRule("PVTI_draft")])
    expect((await failure(run({ ...BOARD, title: "Idea" }))).code).toBe("forbidden")
    expect(mutationNames(installed)).toEqual([])
  })
})

test("declares its board as what it writes to", () => {
  expect(projectItemCreate).toMatchObject({ class: "add", toolset: "projects", targets: { project: "board" } })
  expect(projectItemCreate.description).toContain("Todo")
  expect(projectItemCreate.description).toContain("gh auth refresh -s project")
})
