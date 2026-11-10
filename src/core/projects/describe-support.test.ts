import { describe, expect, test } from "bun:test"
import { installFakeGh } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { ORIGIN } from "../../testing/write-fixtures"
import { DRAFT_ITEM, ISSUE_ITEM, ISSUE_TITLE, archivedItem, itemRules } from "./describe.fixtures"
import { NO_VALUE, describedItem, fieldText, itemHeadline } from "./describe-support"

/** Resolves item `PVTI_1` against the replies `item` gives, in a throwaway working tree. */
async function resolve(item: unknown) {
  const repo = tempRepo(ORIGIN)
  const fake = installFakeGh(itemRules(item))
  try {
    return await describedItem({ item: "PVTI_1" }, { cwd: repo.dir })
  } finally {
    fake.restore()
    repo.cleanup()
  }
}

describe("describedItem", () => {
  test("gives an issue's real title, its type, the board and the field values it holds", async () => {
    const described = await resolve(ISSUE_ITEM)
    expect(described).toMatchObject({ title: ISSUE_TITLE, type: "issue", board: { title: "Roadmap" } })
    expect(described.item.fields).toMatchObject({ Status: "Todo", Estimate: 3, Notes: "Old" })
    expect(described.item.archived).toBe(false)
  })

  test("gives a draft's title and the id of its text", async () => {
    expect(await resolve(DRAFT_ITEM)).toMatchObject({ title: "Plan", type: "draft", draftId: "DI_1" })
  })

  test("tells an archived item", async () => {
    expect((await resolve(archivedItem(true))).item.archived).toBe(true)
  })

  test("an item without readable content has no title and no type", async () => {
    expect(await resolve({ id: "PVTI_1", isArchived: false, fieldValues: { nodes: [] }, content: null })).toMatchObject(
      {
        title: undefined,
        type: undefined,
      },
    )
  })

  test("refuses an item that does not exist as execute does", async () => {
    await expect(resolve(null)).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("itemHeadline", () => {
  test("puts the title in the template's values, and gives none without one", () => {
    expect(itemHeadline("About to do {title}", "Plan")).toEqual({
      headline: { text: "About to do {title}", values: { title: "Plan" } },
    })
    expect(itemHeadline("About to do {title}", undefined)).toEqual({})
  })
})

describe("fieldText", () => {
  test("shows a value as plain text, and no value as a dash", () => {
    expect(fieldText("Todo")).toBe("Todo")
    expect(fieldText(3)).toBe("3")
    expect(fieldText(["bug", "docs"])).toBe("bug, docs")
    expect(fieldText({ title: "Sprint 1", start_date: "2026-11-02", duration: 14 })).toBe("Sprint 1")
    for (const none of [undefined, null, []]) expect(fieldText(none)).toBe(NO_VALUE)
  })
})
