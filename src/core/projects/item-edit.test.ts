import { describe, expect, test } from "bun:test"
import { rawDraftContent, rawIssueContent, rawItem, statusValue } from "../../testing/board-item-fixtures"
import {
  BOARD_SUMMARY,
  boardWithFields,
  clearValueRule,
  contentRule,
  itemReadRule,
  mutationNames,
  mutationsOf,
  rawBoardContent,
  setValueRule,
  updateDraftRule,
} from "../../testing/board-write-fixtures"
import { failure } from "../../testing/issue-fixtures"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { targetKinds } from "../github/targets"
import { projectItemEdit } from "./item-edit"

const { use, run } = writeHarness(projectItemEdit)

const ID = { item: "PVTI_1" }
const ON_BOARD = itemBoardRule("PVTI_1", rawBoard(3))
const sprint = (title: string) => ({ title, startDate: "2026-11-02", duration: 14, field: { name: "Sprint" } })

/** An issue item holding Status Todo, Estimate 3, Notes "Old" and Sprint 1. */
const ISSUE_ITEM = rawItem("PVTI_1", rawIssueContent(12), [
  statusValue("Todo"),
  { number: 3, field: { name: "Estimate" } },
  { text: "Old", field: { name: "Notes" } },
  sprint("Sprint 1"),
])
const DRAFT_ITEM = rawItem("PVTI_1", { ...rawDraftContent("Plan", "Old\n"), id: "DI_1" })

describe("field values", () => {
  test("are set by name, and a value the item already holds is skipped", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", ISSUE_ITEM), ...boardWithFields(), setValueRule()])
    const result = await run({
      ...ID,
      fields: { status: "todo", estimate: 4, notes: "Old", sprint: "sprint 2", target: "2026-12-01" },
    })
    expect(result).toEqual({ project: BOARD_SUMMARY, item_id: "PVTI_1", changed: ["Estimate", "Sprint", "Target"] })
    const writes = mutationsOf(installed)
    expect(writes.map(({ name, vars }) => [name, vars.project, vars.item, vars.field, vars.value])).toEqual([
      ["updateProjectV2ItemFieldValue", "PVT_3", "PVTI_1", "F_estimate", undefined],
      ["updateProjectV2ItemFieldValue", "PVT_3", "PVTI_1", "F_sprint", "IT_2"],
      ["updateProjectV2ItemFieldValue", "PVT_3", "PVTI_1", "F_target", "2026-12-01"],
    ])
    expect(writes[0]!.query).toContain("value:{number:4}")
  })

  test("a field is cleared only when it holds a value", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", ISSUE_ITEM), ...boardWithFields(), clearValueRule()])
    const result = await run({ ...ID, clear_fields: ["NOTES", "Target", "notes"] })
    expect(result.changed).toEqual(["Notes"])
    expect(mutationsOf(installed)).toEqual([
      expect.objectContaining({
        name: "clearProjectV2ItemFieldValue",
        vars: { project: "PVT_3", item: "PVTI_1", field: "F_notes" },
      }),
    ])
  })

  test("values already in place change nothing and write nothing", async () => {
    const installed = use([
      ON_BOARD,
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
      clearValueRule(),
    ])
    const result = await run({
      ...ID,
      fields: { Status: "Todo", Estimate: "3", Sprint: "Sprint 1" },
      clear_fields: ["Target"],
    })
    expect(result.changed).toEqual([])
    expect(mutationNames(installed)).toEqual([])
  })
})

describe("a draft's text", () => {
  test("title and body are written in one call, and only what differs", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", DRAFT_ITEM), updateDraftRule()])
    expect((await run({ ...ID, title: " Plan v2 ", body: "New" })).changed).toEqual(["title", "body"])
    expect(mutationsOf(installed)).toEqual([
      expect.objectContaining({
        name: "updateProjectV2DraftIssue",
        vars: { draft: "DI_1", title: "Plan v2", body: "New" },
      }),
    ])

    const same = use([ON_BOARD, itemReadRule("PVTI_1", DRAFT_ITEM), updateDraftRule()])
    expect((await run({ ...ID, title: "Plan", body: "Brand new" })).changed).toEqual(["body"])
    expect(mutationsOf(same)[0]!.vars).not.toHaveProperty("title")
  })

  test("append_body adds after a blank line, as github_issue_edit does", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", DRAFT_ITEM), updateDraftRule()])
    expect((await run({ ...ID, append_body: "More" })).changed).toEqual(["body"])
    expect(mutationsOf(installed)[0]!.vars.body).toBe("Old\n\nMore")
  })

  test("text already in place writes nothing", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", DRAFT_ITEM), updateDraftRule()])
    expect((await run({ ...ID, title: "Plan", body: "Old\n" })).changed).toEqual([])
    expect(mutationNames(installed)).toEqual([])
  })

  test("fields and text go together, the fields first", async () => {
    const installed = use([
      ON_BOARD,
      itemReadRule("PVTI_1", DRAFT_ITEM),
      ...boardWithFields(),
      setValueRule(),
      updateDraftRule(),
    ])
    expect((await run({ ...ID, fields: { Status: "Done" }, title: "Plan 2" })).changed).toEqual(["Status", "title"])
    expect(mutationNames(installed)).toEqual(["updateProjectV2ItemFieldValue", "updateProjectV2DraftIssue"])
  })

  test("on an issue is invalid_argument, pointing at github_issue_edit", async () => {
    const installed = use([ON_BOARD, itemReadRule("PVTI_1", ISSUE_ITEM), updateDraftRule()])
    const error = await failure(run({ ...ID, title: "New" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("this item is an issue")
    expect(error.message).toContain("github_issue_edit")
    expect(mutationNames(installed)).toEqual([])
  })
})

describe("an edit that cannot be made", () => {
  test.each([
    ["a field to set and clear", { fields: { Notes: "x" }, clear_fields: ["notes"] }, "both fields and clear_fields"],
    ["body with append_body", { body: "a", append_body: "b" }, "pass one of them"],
    ["a blank title", { title: "  " }, "title is blank"],
    ["nothing at all", {}, "Nothing to change"],
    ["empty lists", { fields: {}, clear_fields: [], append_body: " " }, "Nothing to change"],
  ])("%s is invalid_argument before GitHub is asked", async (_, args, expected) => {
    const installed = use([])
    const error = await failure(run({ ...ID, ...args }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(sent(installed)).toEqual([])
  })

  test.each([
    ["an unknown field", { fields: { Estimate: 9, Nope: "x" } }, 'no field "Nope"'],
    ["an unknown option", { fields: { Estimate: 9, Status: "Blocked" } }, 'no option "Blocked"'],
    ["a bad date", { fields: { Estimate: 9, Target: "soon" } }, "YYYY-MM-DD"],
    ["a field of GitHub's own", { fields: { Estimate: 9, Title: "x" } }, "GitHub's own"],
    ["clearing a field of GitHub's own", { fields: { Estimate: 9 }, clear_fields: ["Assignees"] }, "GitHub's own"],
    [
      "setting an issue field",
      { fields: { Priority: "High" } },
      "\"Priority\" mirrors the organization's issue field; its value is the issue's own and cannot be set on a board. Set it with issue_fields in github_issue_edit or github_issue_create.",
    ],
    [
      "clearing an issue field",
      { clear_fields: ["Priority"] },
      "\"Priority\" mirrors the organization's issue field; its value is the issue's own and cannot be cleared on a board. Clear it with clear_issue_fields in github_issue_edit.",
    ],
  ])("%s is invalid_argument before the first write", async (_, args, expected) => {
    const installed = use([
      ON_BOARD,
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
      clearValueRule(),
    ])
    const error = await failure(run({ ...ID, ...args }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(mutationNames(installed)).toEqual([])
  })

  test("a write that fails throws, naming what was written before it", async () => {
    use([
      ON_BOARD,
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      { match: "updateProjectV2ItemFieldValue[\\s\\S]*field=F_target", stderr: "boom", code: 1 },
      setValueRule(),
    ])
    const error = await failure(run({ ...ID, fields: { Estimate: 8, Target: "2026-12-01" } }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("boom")
    expect(error.message).toContain("Written before it failed: Estimate.")
  })

  test("a write that fails first says nothing about earlier writes", async () => {
    use([
      ON_BOARD,
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      { match: "updateProjectV2ItemFieldValue", stderr: "boom", code: 1 },
    ])
    const error = await failure(run({ ...ID, fields: { Estimate: 8 } }))
    expect(error.message).not.toContain("Written before")
  })
})

describe("the item", () => {
  test("is found by an issue reference among the issue's items on the board", async () => {
    const installed = use([
      ...octoBoardRules(3),
      contentRule(
        rawBoardContent("Issue", 12, [
          ["PVTI_x", "PVT_9"],
          ["PVTI_1", "PVT_3"],
        ]),
      ),
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
    ])
    const result = await run({ item: "octo/hello#12", project: "octo/3", fields: { Estimate: 5 } })
    expect(result).toMatchObject({ item_id: "PVTI_1", changed: ["Estimate"] })
    expect(mutationsOf(installed)[0]!.vars.item).toBe("PVTI_1")
  })

  test("a bare number means the working tree's repository", async () => {
    const installed = use([
      ...octoBoardRules(3),
      contentRule(rawBoardContent("Issue", 12, [["PVTI_1", "PVT_3"]])),
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
    ])
    await run({ item: "12", project: "octo/3", fields: { Estimate: 5 } })
    const content = sent(installed).find((args) => args.join(" ").includes("issueOrPullRequest"))!
    expect(content).toEqual(expect.arrayContaining(["owner=octo", "name=hello", "n=12"]))
  })

  test("an issue that is not on the board is not_found", async () => {
    use([...octoBoardRules(3), contentRule(rawBoardContent("Issue", 12, [["PVTI_x", "PVT_9"]]))])
    const error = await failure(run({ item: "12", project: "octo/3", fields: { Estimate: 5 } }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#12 is not on octo/projects/3")
  })

  test("an ID whose item is on another board than project names is invalid_argument", async () => {
    const installed = use([
      itemBoardRule("PVTI_1", rawBoard(4)),
      ...octoBoardRules(3),
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
    ])
    const error = await failure(run({ ...ID, project: "octo/3", fields: { Estimate: 5 } }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("octo/projects/4")
    expect(error.message).toContain("octo/projects/3")
    expect(mutationNames(installed)).toEqual([])
  })

  test("an ID with the board it is on named is fine", async () => {
    use([ON_BOARD, ...octoBoardRules(3), itemReadRule("PVTI_1", ISSUE_ITEM), ...boardWithFields(), setValueRule()])
    expect((await run({ ...ID, project: "octo/3", fields: { Estimate: 5 } })).changed).toEqual(["Estimate"])
  })

  test("an ID that does not exist is not_found", async () => {
    use([itemBoardRule("PVTI_1", null)])
    expect((await failure(run({ ...ID, fields: { Estimate: 5 } }))).code).toBe("not_found")
  })

  test("on a board the viewer cannot update is forbidden, before anything is written", async () => {
    const installed = use([
      itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })),
      itemReadRule("PVTI_1", ISSUE_ITEM),
      ...boardWithFields(),
      setValueRule(),
    ])
    expect((await failure(run({ ...ID, fields: { Estimate: 5 } }))).code).toBe("forbidden")
    expect(mutationNames(installed)).toEqual([])
  })

  test("a blank item is invalid_argument", async () => {
    use([])
    expect((await failure(run({ item: "  ", fields: { Estimate: 5 } }))).code).toBe("invalid_argument")
  })
})

test("declares its item as what it writes to, and sends GitHub's own fields to the issue tools", () => {
  expect(projectItemEdit).toMatchObject({ class: "overwrite", toolset: "projects" })
  expect(targetKinds(projectItemEdit.targets)).toEqual({ item: "item" })
  expect(projectItemEdit.description).toContain("github_issue_edit")
  expect(projectItemEdit.description).toContain("gh auth refresh -s project")
})
