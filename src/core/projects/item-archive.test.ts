import { describe, expect, test } from "bun:test"
import { rawIssueContent, rawItem } from "../../testing/board-item-fixtures"
import {
  BOARD_SUMMARY,
  contentRule,
  itemReadRule,
  mutationsOf,
  rawBoardContent,
} from "../../testing/board-write-fixtures"
import { failure } from "../../testing/issue-fixtures"
import { itemBoardRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { mutationRule } from "../../testing/setup-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { targetKinds } from "../github/targets"
import { projectItemArchive, projectItemUnarchive } from "./item-archive"

const ON_BOARD = itemBoardRule("PVTI_1", rawBoard(3))
const item = (archived: boolean) =>
  itemReadRule("PVTI_1", rawItem("PVTI_1", rawIssueContent(12), [], { isArchived: archived }))
const ARCHIVE = mutationRule("archiveProjectV2Item", { archiveProjectV2Item: { item: { id: "PVTI_1" } } })
const UNARCHIVE = mutationRule("unarchiveProjectV2Item", { unarchiveProjectV2Item: { item: { id: "PVTI_1" } } })

describe("github_project_item_archive", () => {
  const { use, run } = writeHarness(projectItemArchive)

  test("archives an item that is on the board", async () => {
    const installed = use([ON_BOARD, item(false), ARCHIVE])
    expect(await run({ item: "PVTI_1" })).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_1",
      archived: true,
      changed: true,
    })
    expect(mutationsOf(installed)).toEqual([
      expect.objectContaining({ name: "archiveProjectV2Item", vars: { project: "PVT_3", item: "PVTI_1" } }),
    ])
  })

  test("leaves an item that is already archived as it is", async () => {
    const installed = use([ON_BOARD, item(true), ARCHIVE])
    expect(await run({ item: "PVTI_1" })).toMatchObject({ archived: true, changed: false })
    expect(mutationsOf(installed)).toEqual([])
  })

  test("finds the item of an issue on the board, archived or not", async () => {
    const installed = use([
      ...octoBoardRules(3),
      contentRule(rawBoardContent("Issue", 12, [["PVTI_1", "PVT_3", true]])),
      item(true),
      ARCHIVE,
    ])
    expect(await run({ item: "octo/hello#12", project: "octo/3" })).toMatchObject({ item_id: "PVTI_1", changed: false })
    expect(mutationsOf(installed)).toEqual([])
  })

  test("an issue that is not on the board is not_found", async () => {
    use([...octoBoardRules(3), contentRule(rawBoardContent("Issue", 12, [["PVTI_x", "PVT_9"]])), ARCHIVE])
    expect((await failure(run({ item: "12", project: "octo/3" }))).code).toBe("not_found")
  })

  test("an ID on another board than project names is invalid_argument", async () => {
    const installed = use([itemBoardRule("PVTI_1", rawBoard(4)), ...octoBoardRules(3), item(false), ARCHIVE])
    expect((await failure(run({ item: "PVTI_1", project: "octo/3" }))).code).toBe("invalid_argument")
    expect(mutationsOf(installed)).toEqual([])
  })

  test("on a board the viewer cannot update is forbidden", async () => {
    const installed = use([itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })), item(false), ARCHIVE])
    expect((await failure(run({ item: "PVTI_1" }))).code).toBe("forbidden")
    expect(mutationsOf(installed)).toEqual([])
  })

  test("declares its item as what it writes to", () => {
    expect(projectItemArchive).toMatchObject({ class: "overwrite", toolset: "projects" })
    expect(targetKinds(projectItemArchive.targets)).toEqual({ item: "item" })
    expect(projectItemArchive.description).toContain("gh auth refresh -s project")
  })
})

describe("github_project_item_unarchive", () => {
  const { use, run } = writeHarness(projectItemUnarchive)

  test("brings an archived item back", async () => {
    const installed = use([ON_BOARD, item(true), UNARCHIVE])
    expect(await run({ item: "PVTI_1" })).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_1",
      archived: false,
      changed: true,
    })
    expect(mutationsOf(installed)).toEqual([
      expect.objectContaining({ name: "unarchiveProjectV2Item", vars: { project: "PVT_3", item: "PVTI_1" } }),
    ])
  })

  test("leaves an item that is not archived as it is", async () => {
    const installed = use([ON_BOARD, item(false), UNARCHIVE])
    expect(await run({ item: "PVTI_1" })).toMatchObject({ archived: false, changed: false })
    expect(mutationsOf(installed)).toEqual([])
  })

  test("declares its item as what it writes to", () => {
    expect(projectItemUnarchive).toMatchObject({ class: "overwrite" })
    expect(targetKinds(projectItemUnarchive.targets)).toEqual({ item: "item" })
  })
})
