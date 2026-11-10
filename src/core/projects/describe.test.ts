import { describe, expect, test } from "bun:test"
import { rawDraftContent, rawItem } from "../../testing/board-item-fixtures"
import {
  BOARD_FIELD_NODES,
  boardWithFields,
  contentRule,
  itemReadRule,
  rawBoardContent,
} from "../../testing/board-write-fixtures"
import { DEPENDENCIES } from "../../testing/issue-fixtures"
import { itemBoardRule, linkedBoardsRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { milestonesRule, repositoryRule } from "../../testing/write-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { digest } from "../write-facts"
import {
  ADDED_TITLE,
  DESCRIBE_CASES,
  addRules,
  DRAFT_BODY,
  DRAFT_ITEM,
  ISSUE_ITEM,
  ISSUE_TITLE,
  archivedItem,
  describeCase,
  itemRules,
  linkRules,
  type DescribeCase,
} from "./describe.fixtures"

/** The methods of a `gh api` call that change something. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

const headline = (text: string, title = ISSUE_TITLE) => ({ text, values: { title } })
const named = (text: string, name: string) => ({ text, values: { name } })
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

describe("github_project_item_add", () => {
  const added = headline("About to add {title} to the project board", ADDED_TITLE)

  test("names the issue by its real title and shows the Status it starts in", async () => {
    expect(await describeCase(DESCRIBE_CASES.addIssue)).toEqual({
      headline: added,
      facts: [board, { label: "Fields", value: "Status: Todo" }],
    })
  })

  test("an issue an open issue blocks starts as Waiting", async () => {
    const description = await describeCase(DESCRIBE_CASES.addBlockedIssue)
    expect(description?.facts).toEqual([board, { label: "Fields", value: "Status: Waiting" }])
  })

  test("blockers that cannot be read leave the Status as Todo", async () => {
    const rules = [{ match: DEPENDENCIES, stderr: "HTTP 500", code: 1 }, ...addRules()]
    const description = await describeCase({ ...DESCRIBE_CASES.addIssue, rules })
    expect(description?.facts).toEqual([board, { label: "Fields", value: "Status: Todo" }])
  })

  test("lists the fields given in order, and a Status among them replaces the default", async () => {
    expect((await describeCase(DESCRIBE_CASES.addWithFields))?.facts).toEqual([
      board,
      { label: "Fields", value: "Estimate: 3.5; Status: Done" },
    ])
  })

  test("a pull request is named by its title and starts as Todo", async () => {
    expect(await describeCase(DESCRIBE_CASES.addPull)).toEqual({
      headline: headline("About to add {title} to the project board", "Add retry"),
      facts: [board, { label: "Fields", value: "Status: Todo" }],
    })
  })

  test("an item on the board already says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.addExisting)).toEqual({
      headline: added,
      facts: [{ label: "State", value: word("Already on the board; nothing is sent") }],
    })
  })

  test("an item on the board already still gets the fields given, and no default Status", async () => {
    expect((await describeCase(DESCRIBE_CASES.addExistingWithFields))?.facts).toEqual([
      board,
      { label: "Fields", value: "Notes: Soon" },
    ])
  })

  const add = DESCRIBE_CASES.addIssue
  test.each([
    ["a blank item", { project: "octo/3", item: " " }, add.rules],
    ["a field the board does not have", { project: "octo/3", item: "12", fields: { Nope: "x" } }, add.rules],
    ["an option the field does not have", { project: "octo/3", item: "12", fields: { Status: "Nope" } }, add.rules],
    ["an issue that does not exist", { project: "octo/3", item: "12" }, [...boardWithFields(), contentRule(null)]],
    [
      "a board the viewer cannot update",
      add.args,
      [...octoBoardRules(3, { viewerCanUpdate: false }), ...add.rules.slice(2)],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...add, args, rules })).toBeUndefined()
  })
})

describe("github_project_item_create", () => {
  const draft = (title: string) => headline("About to create the draft {title}", title)

  test("names the draft by its trimmed title, shows the Status it starts in, and its body as written", async () => {
    expect(await describeCase(DESCRIBE_CASES.createDraft)).toEqual({
      headline: draft("Plan the work"),
      facts: [board, { label: "Fields", value: "Status: Todo" }],
      text: { label: "Draft body", body: "Split it in three." },
    })
  })

  test("without a body there is no text", async () => {
    const description = await describeCase(DESCRIBE_CASES.createBare)
    expect(description?.text).toBeUndefined()
    expect(description?.facts).toEqual([board, { label: "Fields", value: "Status: Todo" }])
  })

  test("lists the fields given, a Status among them replacing the default", async () => {
    expect((await describeCase(DESCRIBE_CASES.createWithFields))?.facts).toEqual([
      board,
      { label: "Fields", value: "Estimate: 5; Status: Waiting" },
    ])
  })

  test("a board without a Status single select gives no Fields fact", async () => {
    const rules = boardWithFields(BOARD_FIELD_NODES.filter((node) => node.name !== "Status"))
    const description = await describeCase({ ...DESCRIBE_CASES.createBare, rules })
    expect(description?.facts).toEqual([board])
  })

  const create = DESCRIBE_CASES.createDraft
  test.each([
    ["a blank title", { project: "octo/3", title: "  " }, create.rules],
    ["a field the board does not have", { project: "octo/3", title: "x", fields: { Nope: "x" } }, create.rules],
    ["an option the field does not have", { project: "octo/3", title: "x", fields: { Status: "Nope" } }, create.rules],
    [
      "a board the viewer cannot update",
      create.args,
      [...octoBoardRules(3, { viewerCanUpdate: false }), ...create.rules.slice(2)],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...create, args, rules })).toBeUndefined()
  })
})

describe("github_project_item_convert", () => {
  const turned = headline("About to turn the draft {title} into an issue", "Plan")

  test("names the draft by its real title and shows its body as the issue's", async () => {
    expect(await describeCase(DESCRIBE_CASES.convertPlain)).toEqual({
      headline: turned,
      facts: [],
      text: { label: "Issue body", body: DRAFT_BODY },
    })
  })

  test("lists the kind, the labels and the milestone as the repository has it", async () => {
    expect((await describeCase(DESCRIBE_CASES.convertFull))?.facts).toEqual([
      { label: "Kind", value: "bug" },
      { label: "Labels", value: "+ui +api" },
      { label: "Milestone", value: "V1" },
    ])
  })

  test("a milestone the call creates is marked new", async () => {
    expect((await describeCase(DESCRIBE_CASES.convertNewMilestone))?.facts).toEqual([
      { label: "Milestone", value: { text: "{name} (new)", values: { name: "v9" } } },
    ])
  })

  test("a draft without a body shows no text", async () => {
    const description = await describeCase(DESCRIBE_CASES.convertEmptyDraft)
    expect(description?.facts).toEqual([{ label: "Labels", value: "+ui" }])
    expect(description?.text).toBeUndefined()
  })

  const convert = DESCRIBE_CASES.convertPlain
  test.each([
    ["an item that is an issue", { item: "PVTI_1" }, itemRules(ISSUE_ITEM, repositoryRule())],
    ["labels with a comma", { item: "PVTI_1", labels: ["a,b"] }, convert.rules],
    ["create_milestone without a milestone", { item: "PVTI_1", create_milestone: true }, convert.rules],
    [
      "a milestone that does not exist",
      { item: "PVTI_1", milestone: "v9" },
      itemRules(DRAFT_ITEM, repositoryRule(), milestonesRule("v0")),
    ],
    [
      "a repository the viewer cannot write to",
      { item: "PVTI_1" },
      itemRules(DRAFT_ITEM, repositoryRule({ permission: "READ" })),
    ],
    [
      "a board the viewer cannot update",
      { item: "PVTI_1" },
      [
        itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })),
        itemReadRule("PVTI_1", DRAFT_ITEM),
        repositoryRule(),
      ],
    ],
    ["an item that does not exist", { item: "PVTI_1" }, itemRules(null, repositoryRule())],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...convert, args, rules })).toBeUndefined()
  })
})

describe("github_project_link and github_project_unlink", () => {
  const link = (text: string) => headline(text, "Roadmap")

  test("link names the board by its real title and has no fact, the repository being a target", async () => {
    expect(await describeCase(DESCRIBE_CASES.link)).toEqual({
      headline: link("About to link the project board {title} to the repository"),
      facts: [],
    })
  })

  test("a board that is linked already says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.linkAlready)).toEqual({
      headline: link("About to link the project board {title} to the repository"),
      facts: [{ label: "State", value: word("Already linked to the repository; nothing is sent") }],
    })
  })

  test("unlink names the board and has no fact", async () => {
    expect(await describeCase(DESCRIBE_CASES.unlink)).toEqual({
      headline: link("About to unlink the project board {title} from the repository"),
      facts: [],
    })
  })

  test("a board that is not linked says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.unlinkAlready)).toEqual({
      headline: link("About to unlink the project board {title} from the repository"),
      facts: [{ label: "State", value: word("Not linked to the repository; nothing is sent") }],
    })
  })

  test.each([
    [
      "a board of another owner than the repository's",
      { project: "octo/3", repo: "acme/widgets" },
      [...linkRules(false), repositoryRule({ repo: "acme/widgets" })],
    ],
    [
      "a board the viewer cannot update",
      DESCRIBE_CASES.link.args,
      [...octoBoardRules(3, { viewerCanUpdate: false }), repositoryRule()],
    ],
    [
      "a repository the viewer cannot write to",
      DESCRIBE_CASES.link.args,
      [...octoBoardRules(3), repositoryRule({ permission: "READ" })],
    ],
  ])("%s: no link description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.link, args, rules })).toBeUndefined()
  })

  test("a board of another owner can still be unlinked, and a board the viewer cannot update cannot", async () => {
    const other = { ...DESCRIBE_CASES.unlink, args: { project: "octo/3", repo: "acme/widgets" } }
    const rules = [
      ...octoBoardRules(3),
      repositoryRule({ repo: "acme/widgets" }),
      linkedBoardsRule("acme", "widgets", []),
    ]
    expect((await describeCase({ ...other, rules }))?.facts).toEqual([
      { label: "State", value: word("Not linked to the repository; nothing is sent") },
    ])
    const readOnly = {
      ...DESCRIBE_CASES.unlink,
      rules: [...octoBoardRules(3, { viewerCanUpdate: false }), repositoryRule()],
    }
    expect(await describeCase(readOnly)).toBeUndefined()
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
