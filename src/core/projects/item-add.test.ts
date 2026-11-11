import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  BOARD_FIELD_NODES,
  BOARD_SUMMARY,
  CONTENT,
  STATUS_OPTIONS,
  addItemRule,
  blockersRule,
  boardWithFields,
  contentRule,
  mutationNames,
  mutationsOf,
  rawBoardContent,
  setValueRule,
} from "../../testing/board-write-fixtures"
import { failure } from "../../testing/issue-fixtures"
import { octoBoardRules } from "../../testing/project-fixtures"
import { rawField } from "../../testing/setup-fixtures"
import { sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { projectItemAdd } from "./item-add"

const { use, run } = writeHarness(projectItemAdd)

const BOARD = { project: "octo/3" }
const ISSUE = { type: "issue" as const, repo: "octo/hello", number: 12, url: "https://github.com/octo/hello/issues/12" }
const NEW_ISSUE = contentRule(rawBoardContent("Issue", 12, [["PVTI_other", "PVT_9"]]))
const queried = (installed: Parameters<typeof sent>[0], text: string) =>
  sent(installed).some((args) => args.join(" ").includes(text))

afterEach(() => setSystemTime())

describe("a new item", () => {
  test("is added by its node ID and starts as Todo", async () => {
    const installed = use([...boardWithFields(), NEW_ISSUE, blockersRule(), addItemRule("PVTI_new"), setValueRule()])
    expect(await run({ ...BOARD, item: "12" })).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_new",
      created: true,
      archived: false,
      content: ISSUE,
      fields: { Status: "Todo" },
      errors: {},
    })
    const [add, status, ...others] = mutationsOf(installed)
    expect(others).toEqual([])
    expect(add).toMatchObject({ name: "addProjectV2ItemById", vars: { project: "PVT_3", content: "I_12" } })
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_todo" },
    })
    expect(status!.query).toContain("value:{singleSelectOptionId:$value}")
  })

  test("takes a reference of any form, and a pull request starts as Todo without reading blockers", async () => {
    const installed = use([
      ...boardWithFields(),
      contentRule(rawBoardContent("PullRequest", 7)),
      addItemRule("PVTI_new"),
      setValueRule(),
    ])
    const result = await run({ ...BOARD, item: "https://github.com/octo/hello/pull/7" })
    expect(result).toMatchObject({
      created: true,
      content: { type: "pr", number: 7, url: "https://github.com/octo/hello/pull/7" },
      fields: { Status: "Todo" },
    })
    expect(queried(installed, "blockedBy")).toBe(false)
  })

  test("sets the fields given, each by its own write, checked against the board's", async () => {
    setSystemTime(new Date("2026-11-20T08:00:00Z"))
    const installed = use([...boardWithFields(), NEW_ISSUE, blockersRule(), addItemRule("PVTI_new"), setValueRule()])
    const result = await run({
      ...BOARD,
      item: "octo/hello#12",
      fields: { notes: "Soon", estimate: "3.5", target: "2026-12-01", sprint: "@current", status: "done" },
    })
    expect(result.fields).toEqual({
      Notes: "Soon",
      Estimate: 3.5,
      Target: "2026-12-01",
      Sprint: "Sprint 2",
      Status: "Done",
    })
    const [, ...writes] = mutationsOf(installed)
    expect(writes.map(({ vars }) => [vars.field, vars.value])).toEqual([
      ["F_notes", "Soon"],
      ["F_estimate", undefined],
      ["F_target", "2026-12-01"],
      ["F_sprint", "IT_2"],
      ["F_status", "O_done"],
    ])
    expect(writes[1]!.query).toContain("value:{number:3.5}")
    expect(writes[2]!.query).toContain("$value:Date!")
    expect(writes[3]!.query).toContain("value:{iterationId:$value}")
  })
})

describe("the Status a new item starts in", () => {
  const statusWrite = (installed: Parameters<typeof mutationsOf>[0]) => mutationsOf(installed)[1]?.vars.value

  test("is Waiting for an issue with an open blocking issue", async () => {
    const installed = use([
      ...boardWithFields(),
      NEW_ISSUE,
      blockersRule("CLOSED", "OPEN"),
      addItemRule("I"),
      setValueRule(),
    ])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({ Status: "Waiting" })
    expect(statusWrite(installed)).toBe("O_wait")
  })

  test("is Todo when the blocking issues are all closed", async () => {
    const installed = use([...boardWithFields(), NEW_ISSUE, blockersRule("CLOSED"), addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({ Status: "Todo" })
    expect(statusWrite(installed)).toBe("O_todo")
  })

  test("is Todo when the board has no Waiting option, and the blockers are not read", async () => {
    const fields = BOARD_FIELD_NODES.map((node) =>
      node.name === "Status"
        ? rawField("F_status", "Status", "SINGLE_SELECT", [STATUS_OPTIONS[0], STATUS_OPTIONS[2]])
        : node,
    )
    const installed = use([...boardWithFields(fields), NEW_ISSUE, addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({ Status: "Todo" })
    expect(queried(installed, "blockedBy")).toBe(false)
  })

  test("is Waiting alone when the board has no Todo option, and nothing when no blocker waits", async () => {
    const fields = BOARD_FIELD_NODES.map((node) =>
      node.name === "Status" ? rawField("F_status", "Status", "SINGLE_SELECT", [STATUS_OPTIONS[1]]) : node,
    )
    use([...boardWithFields(fields), NEW_ISSUE, blockersRule("OPEN"), addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({ Status: "Waiting" })
    const installed = use([...boardWithFields(fields), NEW_ISSUE, blockersRule(), addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({})
    expect(mutationNames(installed)).toEqual(["addProjectV2ItemById"])
  })

  test("is nothing on a board without a Status single select", async () => {
    const fields = BOARD_FIELD_NODES.filter((node) => node.name !== "Status")
    const installed = use([...boardWithFields(fields), NEW_ISSUE, addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({})
    expect(mutationNames(installed)).toEqual(["addProjectV2ItemById"])

    const text = BOARD_FIELD_NODES.map((node) =>
      node.name === "Status" ? rawField("F_status", "Status", "TEXT") : node,
    )
    use([...boardWithFields(text), NEW_ISSUE, addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12" })).fields).toEqual({})
  })

  test("yields to a Status the caller gives, whatever the case of its name", async () => {
    const installed = use([...boardWithFields(), NEW_ISSUE, blockersRule("OPEN"), addItemRule("I"), setValueRule()])
    expect((await run({ ...BOARD, item: "12", fields: { STATUS: "Done" } })).fields).toEqual({ Status: "Done" })
    expect(queried(installed, "blockedBy")).toBe(false)
    expect(mutationsOf(installed).map(({ vars }) => vars.value)).toEqual([undefined, "O_done"])
  })

  test("is not given to an item that was already on the board", async () => {
    const installed = use([
      ...boardWithFields(),
      contentRule(rawBoardContent("Issue", 12, [["PVTI_here", "PVT_3"]])),
      blockersRule("OPEN"),
      setValueRule(),
    ])
    const result = await run({ ...BOARD, item: "12" })
    expect(result).toMatchObject({ item_id: "PVTI_here", created: false, fields: {} })
    expect(mutationNames(installed)).toEqual([])
    expect(queried(installed, "blockedBy")).toBe(false)
  })

  test("is Todo when the blocking issues cannot be read, and errors.blocked_by says why", async () => {
    const installed = use([
      ...boardWithFields(),
      NEW_ISSUE,
      { match: "blockedBy\\(first", stderr: "dependencies are off", code: 1 },
      addItemRule("PVTI_new"),
      setValueRule(),
    ])
    const result = await run({ ...BOARD, item: "12" })
    expect(result).toMatchObject({ item_id: "PVTI_new", created: true, fields: { Status: "Todo" } })
    expect(result.errors).toEqual({ blocked_by: "upstream_error: gh failed (exit 1): dependencies are off" })
    expect(mutationsOf(installed)[1]!.vars.value).toBe("O_todo")
  })
})

describe("an item that is already on the board", () => {
  const PRESENT = contentRule(
    rawBoardContent("Issue", 12, [
      ["PVTI_other", "PVT_9"],
      ["PVTI_old", "PVT_3", true],
    ]),
  )

  test("is returned as it is, archived or not, and only the given fields are set", async () => {
    const installed = use([...boardWithFields(), PRESENT, addItemRule("PVTI_new"), setValueRule()])
    expect(await run({ ...BOARD, item: "#12", fields: { Estimate: 2 } })).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_old",
      created: false,
      archived: true,
      content: ISSUE,
      fields: { Estimate: 2 },
      errors: {},
    })
    expect(mutationNames(installed)).toEqual(["updateProjectV2ItemFieldValue"])
    expect(mutationsOf(installed)[0]!.vars.item).toBe("PVTI_old")
  })

  test("adding it again writes nothing", async () => {
    const installed = use([...boardWithFields(), PRESENT, addItemRule("PVTI_new")])
    expect(await run({ ...BOARD, item: "12" })).toMatchObject({ item_id: "PVTI_old", created: false, fields: {} })
    expect(mutationNames(installed)).toEqual([])
  })
})

describe("field writes after the item exists", () => {
  test("a field that fails is listed under errors, and the others still land", async () => {
    use([
      ...boardWithFields(),
      NEW_ISSUE,
      blockersRule(),
      addItemRule("PVTI_new"),
      { match: "updateProjectV2ItemFieldValue[\\s\\S]*field=F_estimate", stderr: "boom", code: 1 },
      setValueRule(),
    ])
    const result = await run({ ...BOARD, item: "12", fields: { Estimate: 1, Notes: "kept" } })
    expect(result.item_id).toBe("PVTI_new")
    expect(result.fields).toEqual({ Notes: "kept", Status: "Todo" })
    expect(result.errors).toEqual({ "fields.Estimate": "upstream_error: gh failed (exit 1): boom" })
  })
})

describe("before anything is written", () => {
  test.each([
    ["an unknown field", { Nope: "x" }, 'no field "Nope"'],
    ["an unknown option", { Status: "Blocked" }, 'no option "Blocked"'],
    ["a bad date", { Target: "tomorrow" }, "YYYY-MM-DD"],
    ["a field of GitHub's own", { Title: "x" }, "GitHub's own"],
    [
      "a milestone, which the issue sets",
      { Milestone: "v1" },
      "github_issue_edit sets assignees, labels and milestone",
    ],
  ])("%s is invalid_argument, and the item is not added", async (_, fields, expected) => {
    const installed = use([...boardWithFields(), NEW_ISSUE, blockersRule(), addItemRule("PVTI_new"), setValueRule()])
    const error = await failure(run({ ...BOARD, item: "12", fields }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(mutationNames(installed)).toEqual([])
    expect(queried(installed, CONTENT)).toBe(false)
  })

  test("a board the viewer cannot update is forbidden", async () => {
    const installed = use([...octoBoardRules(3, { viewerCanUpdate: false }), NEW_ISSUE, addItemRule("PVTI_new")])
    expect((await failure(run({ ...BOARD, item: "12" }))).code).toBe("forbidden")
    expect(mutationNames(installed)).toEqual([])
  })

  test("an issue that does not exist is not_found", async () => {
    use([...boardWithFields(), contentRule(null)])
    const error = await failure(run({ ...BOARD, item: "99" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#99")
  })

  test("a reference that is no issue or pull request is invalid_argument", async () => {
    use([])
    expect((await failure(run({ ...BOARD, item: "PVTI_abc" }))).code).toBe("invalid_argument")
  })
})

test("declares its board as what it writes to, and says the Status it starts in", () => {
  expect(projectItemAdd).toMatchObject({ class: "idempotent", toolset: "projects", targets: { project: "board" } })
  expect(projectItemAdd.description).toContain("Waiting")
  expect(projectItemAdd.description).toContain("gh auth refresh -s project")
})
