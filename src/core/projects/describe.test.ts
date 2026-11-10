import { describe, expect, test } from "bun:test"
import { rawDraftContent, rawItem } from "../../testing/board-item-fixtures"
import { boardWithFields, contentRule, itemReadRule, rawBoardContent } from "../../testing/board-write-fixtures"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { digest } from "../write-facts"
import {
  DESCRIBE_CASES,
  DRAFT_BODY,
  DRAFT_ITEM,
  ISSUE_ITEM,
  ISSUE_TITLE,
  archivedItem,
  describeCase,
  itemRules,
  type DescribeCase,
} from "./describe.fixtures"

/** The methods of a `gh api` call that change something. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

const headline = (text: string, title = ISSUE_TITLE) => ({ text, values: { title } })
const word = (text: string) => ({ text })
const board = { label: "Board", value: "Roadmap" }

describe("github_project_item_edit", () => {
  test("lists the field writes with the value the item holds now, skipping a value it holds already", async () => {
    expect(await describeCase(DESCRIBE_CASES.editFields)).toEqual({
      headline: headline("About to edit the project item {title}"),
      facts: [
        board,
        {
          label: "Fields",
          value: "Status: Todo → Done; Estimate: 3 → 4; Sprint: Sprint 1 → Sprint 2; Target: — → 2026-12-01",
        },
      ],
    })
  })

  test("lists the fields to clear that hold a value, by the board's spelling", async () => {
    expect(await describeCase(DESCRIBE_CASES.editClearing)).toEqual({
      headline: headline("About to edit the project item {title}"),
      facts: [board, { label: "Cleared fields", value: "\u2212Notes" }],
    })
  })

  test("names an issue found by its reference by the title GitHub holds", async () => {
    const description = await describeCase(DESCRIBE_CASES.editByReference)
    expect(description?.headline).toEqual(headline("About to edit the project item {title}"))
    expect(description?.facts).toEqual([board, { label: "Fields", value: "Status: Todo → Waiting" }])
  })

  test("values in place say nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.editInPlace)).toEqual({
      headline: headline("About to edit the project item {title}"),
      facts: [{ label: "State", value: word("Already in place; nothing is sent") }],
    })
  })

  test("a draft's new title and body show, and the body it replaces is pinned", async () => {
    expect(await describeCase(DESCRIBE_CASES.editDraftReplacing)).toEqual({
      headline: headline("About to edit the project item {title}", "Plan"),
      facts: [
        board,
        { label: "Fields", value: "Status: — → Done" },
        { label: "Title", value: "Plan v2" },
        { label: "Body", value: word("Replaced") },
      ],
      text: { label: "New body", body: "New body" },
      pins: { body: digest(DRAFT_BODY) },
    })
  })

  test("clearing a draft's body shows no text and pins the body it clears", async () => {
    expect(await describeCase(DESCRIBE_CASES.editDraftClearing)).toEqual({
      headline: headline("About to edit the project item {title}", "Plan"),
      facts: [board, { label: "Body", value: word("Cleared") }],
      pins: { body: digest(DRAFT_BODY) },
    })
  })

  test("appending to a draft's body shows the appended text and pins nothing", async () => {
    expect(await describeCase(DESCRIBE_CASES.editDraftAppending)).toEqual({
      headline: headline("About to edit the project item {title}", "Plan"),
      facts: [board, { label: "Body", value: word("Appended") }],
      text: { label: "Appended text", body: "More" },
    })
  })

  test("a draft whose text is in place says nothing is sent, and shows no text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editDraftInPlace)).toEqual({
      headline: headline("About to edit the project item {title}", "Plan"),
      facts: [{ label: "State", value: word("Already in place; nothing is sent") }],
    })
  })

  const edit = DESCRIBE_CASES.editFields
  test.each([
    ["a body on an issue", { item: "PVTI_1", body: "x" }, edit.rules],
    ["a title on an issue", { item: "PVTI_1", title: "x" }, edit.rules],
    [
      "a field in both fields and clear_fields",
      { item: "PVTI_1", fields: { Status: "Done" }, clear_fields: ["status"] },
      edit.rules,
    ],
    ["body with append_body", { item: "PVTI_1", body: "a", append_body: "b" }, itemRules(DRAFT_ITEM)],
    ["a blank title", { item: "PVTI_1", title: " " }, itemRules(DRAFT_ITEM)],
    ["nothing to change", { item: "PVTI_1" }, edit.rules],
    ["a blank item", { item: " ", fields: { Status: "Done" } }, edit.rules],
    ["a field the board does not have", { item: "PVTI_1", fields: { Nope: "x" } }, edit.rules],
    ["an option the field does not have", { item: "PVTI_1", fields: { Status: "Nope" } }, edit.rules],
    ["a field GitHub owns", { item: "PVTI_1", fields: { Title: "x" } }, edit.rules],
    ["a clear of a field GitHub owns", { item: "PVTI_1", clear_fields: ["Assignees"] }, edit.rules],
    ["a number for a date field", { item: "PVTI_1", fields: { Target: 5 } }, edit.rules],
    [
      "a board the viewer cannot update",
      { item: "PVTI_1", fields: { Status: "Done" } },
      [itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })), itemReadRule("PVTI_1", ISSUE_ITEM)],
    ],
    [
      "an item that does not exist",
      { item: "PVTI_1", fields: { Status: "Done" } },
      itemRules(null, ...boardWithFields()),
    ],
    [
      "a draft whose text GitHub did not return",
      { item: "PVTI_1", title: "x" },
      itemRules(rawItem("PVTI_1", rawDraftContent("Plan", "Old"))),
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...edit, args, rules })).toBeUndefined()
  })
})

describe("github_project_item_archive", () => {
  const onBoard = { headline: headline("About to archive the project item {title}") }

  test("names the item by its real title and the board it leaves", async () => {
    expect(await describeCase(DESCRIBE_CASES.archive)).toEqual({ ...onBoard, facts: [board] })
  })

  test("finds an issue named by its reference", async () => {
    expect(await describeCase(DESCRIBE_CASES.archiveByReference)).toEqual({ ...onBoard, facts: [board] })
  })

  test("an item archived already says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.archiveArchived)).toEqual({
      ...onBoard,
      facts: [{ label: "State", value: word("Already archived; nothing is sent") }],
    })
  })

  test.each([
    [
      "a board the viewer cannot update",
      { item: "PVTI_1" },
      [itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })), itemReadRule("PVTI_1", archivedItem(false))],
    ],
    [
      "an item on another board than project names",
      { item: "PVTI_1", project: "octo/3" },
      [itemBoardRule("PVTI_1", rawBoard(4)), ...octoBoardRules(3), itemReadRule("PVTI_1", archivedItem(false))],
    ],
    ["an item that does not exist", { item: "PVTI_1" }, itemRules(null)],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.archive, args, rules })).toBeUndefined()
  })

  test("an issue that is not on the board gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.archiveByReference,
      rules: [...octoBoardRules(3), contentRule(rawBoardContent("Issue", 12, [["PVTI_x", "PVT_9"]]))],
    }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_project_item_unarchive", () => {
  const onBoard = { headline: headline("About to restore the project item {title} from the archive") }

  test("names the item by its real title and the board it returns to", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchive)).toEqual({ ...onBoard, facts: [board] })
  })

  test("an item that is not archived says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchiveActive)).toEqual({
      ...onBoard,
      facts: [{ label: "State", value: word("Not archived; nothing is sent") }],
    })
  })

  test("a board the viewer cannot update gives no description", async () => {
    const rules = [
      itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })),
      itemReadRule("PVTI_1", archivedItem(true)),
    ]
    expect(await describeCase({ ...DESCRIBE_CASES.unarchive, rules })).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values<DescribeCase>(DESCRIBE_CASES)

  test.each(cases.map((item) => [item.name, item] as const))("%s: is within the budgets", async (_name, item) => {
    const description = await describeCase(item)
    expect(description).toBeDefined()
    expect(Array.from(description!.headline!.text).length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH)
    expect(description!.facts.length).toBeLessThanOrEqual(MAX_FACTS)
    for (const { label } of description!.facts) expect(Array.from(label).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
  })

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: is the same when asked twice",
    async (_name, item) => {
      expect(await describeCase(item)).toEqual(await describeCase(item))
    },
  )

  test.each(cases.map((item) => [item.name, item] as const))("%s: only reads", async (_name, item) => {
    let calls: string[][] = []
    await describeCase(item, (seen) => (calls = seen))
    const isWrite = (args: string[]) =>
      queryOf(args).startsWith("mutation") || WRITE_METHODS.some((method) => args.includes(method))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(isWrite)).toEqual([])
  })

  test("a failing read gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.archive,
      rules: [
        itemBoardRule("PVTI_1", rawBoard(3)),
        { match: "ProjectV2Item\\{id isArchived", stderr: "HTTP 500", code: 1 },
      ],
    }
    expect(await describeCase(item)).toBeUndefined()
  })
})
