import { describe, expect, test } from "bun:test"
import { contentRule, itemReadRule, rawBoardContent } from "../../testing/board-write-fixtures"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
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
