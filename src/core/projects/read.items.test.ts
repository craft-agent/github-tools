import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { apiCalls, failure } from "../../testing/issue-fixtures"
import {
  ITEMS,
  issueFieldValue,
  itemsPage,
  itemsRule,
  rawDraftContent,
  rawIssueContent,
  rawItem,
  rawPullContent,
  statusValue,
} from "../../testing/board-item-fixtures"
import {
  linkedBoardsRule,
  octoBoardRules,
  ownerBoardsRule,
  rawBoard,
  viewerBoardsRule,
} from "../../testing/project-fixtures"
import { invoke } from "../tool"
import { projectRead } from "./read"

const ORIGIN = "https://github.com/octo/hello.git"
const PROJECT = { number: 3, title: "Roadmap", url: "https://github.com/orgs/octo/projects/3", owner: "octo" }

let repo: TempRepo
let fake: FakeGh | undefined

beforeEach(() => {
  repo = tempRepo(ORIGIN)
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

const list = (args: Record<string, unknown> = {}) =>
  invoke(projectRead, { method: "item_list", project: "octo/3", ...args }, { cwd: repo.dir })

const numbers = (result: Awaited<ReturnType<typeof list>>) => result.items?.map((item) => item.item_id)

/** A board of five items: an issue, a pull request, a draft, an archived issue and one whose content GitHub withheld. */
const BOARD_ITEMS = [
  rawItem("PVTI_issue", rawIssueContent(1, { title: "Crash on save" }), [statusValue("Todo")]),
  rawItem("PVTI_pull", rawPullContent(2), [statusValue("In Progress")]),
  rawItem("PVTI_draft", rawDraftContent("Plan the launch", "Notes"), [statusValue("todo")]),
  rawItem("PVTI_old", rawIssueContent(4, { issueState: "CLOSED" }), [statusValue("Done")], { isArchived: true }),
  rawItem("PVTI_hidden", null, [{ text: "Secret thing", field: { name: "Title" } }]),
]

describe("item_list: the items", () => {
  test("flattens each item, with its content by type", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(await list({ include_archived: true })).toEqual({
      project: PROJECT,
      count: 5,
      truncated: false,
      items: [
        {
          item_id: "PVTI_issue",
          archived: false,
          fields: { Status: "Todo" },
          content: {
            type: "issue",
            number: 1,
            title: "Crash on save",
            url: "https://github.com/octo/hello/issues/1",
            repo: "octo/hello",
            state: "open",
            assignees: [],
            labels: [],
            kind: null,
            parent: null,
            sub_issues: { total: 0, completed: 0 },
          },
        },
        {
          item_id: "PVTI_pull",
          archived: false,
          fields: { Status: "In Progress" },
          content: {
            type: "pr",
            number: 2,
            title: "Pull 2",
            url: "https://github.com/octo/hello/pull/2",
            repo: "octo/hello",
            state: "merged",
            assignees: ["bob"],
            labels: ["ui"],
          },
        },
        {
          item_id: "PVTI_draft",
          archived: false,
          fields: { Status: "todo" },
          content: { type: "draft", title: "Plan the launch", body: "Notes" },
        },
        expect.objectContaining({ item_id: "PVTI_old", archived: true }),
        { item_id: "PVTI_hidden", archived: false, fields: { Title: "Secret thing" }, content: null },
      ],
    })
  })

  test("an issue's kind, parent and sub-issue progress come from the issue", async () => {
    const withIssueType = rawIssueContent(5, {
      issueType: { name: "Bug" },
      parent: { number: 1, repository: { nameWithOwner: "octo/other" } },
      subIssuesSummary: { total: 3, completed: 2 },
    })
    const withLabel = rawIssueContent(6, { labels: { nodes: [{ name: "priority" }, { name: "type:feature" }] } })
    useFake([...octoBoardRules(3), itemsRule([rawItem("PVTI_a", withIssueType), rawItem("PVTI_b", withLabel)])])
    const [first, second] = (await list()).items!
    expect(first!.content).toMatchObject({
      kind: "bug",
      parent: "octo/other#1",
      sub_issues: { total: 3, completed: 2 },
    })
    expect(second!.content).toMatchObject({ kind: "feature", labels: ["priority", "type:feature"], parent: null })
  })

  test("every kind of field value is flattened by the field's name", async () => {
    const values = [
      { text: "a note", field: { name: "Notes" } },
      { number: 5, field: { name: "Estimate" } },
      { date: "2026-12-01", field: { name: "Target" } },
      statusValue("Todo"),
      { title: "Sprint 1", startDate: "2026-11-02", duration: 14, field: { name: "Sprint" } },
      { milestone: { title: "v1" }, field: { name: "Milestone" } },
      { milestone: null, field: { name: "Other milestone" } },
      { repository: { nameWithOwner: "octo/hello" }, field: { name: "Repository" } },
      { labels: { nodes: [{ name: "a" }, { name: "b" }] }, field: { name: "Labels" } },
      { users: { nodes: [{ login: "bob" }, { login: "carol" }] }, field: { name: "Assignees" } },
      { pullRequests: { nodes: [{ number: 7 }, { number: 9 }] }, field: { name: "Linked pull requests" } },
      { field: { name: "Reviewers" } },
      { text: "nameless" },
      {},
      null,
    ]
    useFake([...octoBoardRules(3), itemsRule([rawItem("PVTI_a", null, values)])])
    expect((await list()).items![0]!.fields).toEqual({
      Notes: "a note",
      Estimate: 5,
      Target: "2026-12-01",
      Status: "Todo",
      Sprint: { title: "Sprint 1", start_date: "2026-11-02", duration: 14 },
      Milestone: "v1",
      "Other milestone": null,
      Repository: "octo/hello",
      Labels: ["a", "b"],
      Assignees: ["bob", "carol"],
      "Linked pull requests": [7, 9],
    })
  })

  test("shows values of columns mirroring organization issue fields", async () => {
    const values = [
      issueFieldValue("Target date", { __typename: "IssueFieldDateValue", value: "2026-11-30" }),
      issueFieldValue("Severity", { __typename: "IssueFieldSingleSelectValue", name: "Critical" }),
    ]
    useFake([...octoBoardRules(3), itemsRule([rawItem("PVTI_1", null, values)])])
    const result = await list()
    expect(result.items![0]!.fields).toEqual({
      "Target date": "2026-11-30",
      Severity: "Critical",
    })
  })

  test("a project that is a title is looked up", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(4, { title: "Plan" })]), itemsRule([])])
    const result = await list({ project: "plan" })
    expect(result.project).toEqual({
      ...PROJECT,
      number: 4,
      title: "Plan",
      url: "https://github.com/orgs/octo/projects/4",
    })
  })

  test("without project, the board comes from the lookup", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(4)]), itemsRule([])])
    const result = await invoke(projectRead, { method: "item_list" }, { cwd: repo.dir })
    expect(result).toEqual({
      project: { ...PROJECT, number: 4, url: "https://github.com/orgs/octo/projects/4" },
      count: 0,
      truncated: false,
      items: [],
    })
  })
})

describe("item_list: filters", () => {
  test("archived items are left out unless include_archived", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list())).toEqual(["PVTI_issue", "PVTI_pull", "PVTI_draft", "PVTI_hidden"])
    expect(numbers(await list({ include_archived: true }))).toContain("PVTI_old")
  })

  test("status names are comma-separated and case-insensitive", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: "TODO" }))).toEqual(["PVTI_issue", "PVTI_draft"])
    expect(numbers(await list({ status: " todo , in progress " }))).toEqual(["PVTI_issue", "PVTI_pull", "PVTI_draft"])
  })

  test("an item without a Status matches no included status", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: "Todo, In Progress, Done" }))).not.toContain("PVTI_hidden")
  })

  test("-Name leaves a status out, and keeps items with no Status", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: "-todo" }))).toEqual(["PVTI_pull", "PVTI_hidden"])
    expect(numbers(await list({ status: "-Todo,-In Progress" }))).toEqual(["PVTI_hidden"])
  })

  test("included and excluded names both apply", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: "Todo,In Progress,-in progress" }))).toEqual(["PVTI_issue", "PVTI_draft"])
  })

  test.each([
    ["issue", ["PVTI_issue"]],
    ["pr", ["PVTI_pull"]],
    ["draft", ["PVTI_draft"]],
  ])("content_type %s; an item with no content matches none", async (type, expected) => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ content_type: type }))).toEqual(expected)
  })

  test("content_repo matches issues and pull requests of that repository, never drafts", async () => {
    const elsewhere = rawItem("PVTI_else", rawIssueContent(8, { repository: { nameWithOwner: "Octo/Else" } }))
    useFake([...octoBoardRules(3), itemsRule([...BOARD_ITEMS, elsewhere])])
    expect(numbers(await list({ content_repo: "OCTO/hello" }))).toEqual(["PVTI_issue", "PVTI_pull"])
    expect(numbers(await list({ content_repo: "octo/else" }))).toEqual(["PVTI_else"])
  })

  test("search is a case-insensitive part of the title, falling back to the Title field", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ search: "CRASH" }))).toEqual(["PVTI_issue"])
    expect(numbers(await list({ search: "launch" }))).toEqual(["PVTI_draft"])
    expect(numbers(await list({ search: "secret" }))).toEqual(["PVTI_hidden"])
    expect(numbers(await list({ search: "nothing like it" }))).toEqual([])
  })

  test("blank filters count as not given", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: " ", content_repo: "", search: "  " }))).toHaveLength(4)
  })

  test("filters combine", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    expect(numbers(await list({ status: "todo", content_type: "draft", search: "plan" }))).toEqual(["PVTI_draft"])
    expect(numbers(await list({ status: "todo", content_type: "pr" }))).toEqual([])
  })
})

describe("item_list: limit and truncation", () => {
  test("limit cuts the matches, and says so", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    const result = await list({ limit: 2 })
    expect(numbers(result)).toEqual(["PVTI_issue", "PVTI_pull"])
    expect(result.count).toBe(2)
    expect(result.truncated).toBe(true)
  })

  test("a limit that fits the matches exactly is not truncation; archived ones do not count", async () => {
    useFake([...octoBoardRules(3), itemsRule(BOARD_ITEMS)])
    const result = await list({ limit: 4 })
    expect(result.count).toBe(4)
    expect(result.truncated).toBe(false)
  })

  test("limit defaults to 100", async () => {
    const many = Array.from({ length: 120 }, (_, index) => rawItem(`PVTI_${index}`, null))
    useFake([...octoBoardRules(3), itemsRule(many)])
    const result = await list()
    expect(result.count).toBe(100)
    expect(result.truncated).toBe(true)
  })

  test("reads pages of 100 up to 2000 items, filters the lot, and says the board held more", async () => {
    const page = (index: number) =>
      Array.from({ length: 100 }, (_, item) =>
        rawItem(`PVTI_${index}_${item}`, rawDraftContent(`Draft ${index}`), [
          statusValue(index === 19 && item === 99 ? "Done" : "Todo"),
        ]),
      )
    const pages: GhRule[] = Array.from({ length: 20 }, (_, index) => ({
      match: ITEMS,
      stdout: itemsPage(page(index), `c${index + 1}`),
      times: 1,
    }))
    const installed = useFake([...octoBoardRules(3), ...pages])
    const result = await list({ status: "done", limit: 2000 })
    expect(numbers(result)).toEqual(["PVTI_19_99"])
    expect(result.truncated).toBe(true)
    expect(apiCalls(installed).filter((args) => args.join(" ").includes("items(first:100"))).toHaveLength(20)
  })

  test("a board that ends within the cap is not truncated, whatever the page count", async () => {
    useFake([
      ...octoBoardRules(3),
      { match: ITEMS, stdout: itemsPage([rawItem("PVTI_1", null)], "c1"), times: 1 },
      { match: ITEMS, stdout: itemsPage([rawItem("PVTI_2", null)]) },
    ])
    const result = await list()
    expect(numbers(result)).toEqual(["PVTI_1", "PVTI_2"])
    expect(result.truncated).toBe(false)
  })
})

describe("item_list: arguments", () => {
  test.each([
    ["content_repo", "not a repo"],
    ["status", "Todo,-"],
    ["content_type", "milestone"],
    ["limit", 0],
    ["limit", 2001],
    ["limit", 1.5],
  ])("%s %p is invalid_argument and nothing is asked of GitHub", async (name, value) => {
    const installed = useFake([...octoBoardRules(3), itemsRule([])])
    const error = await failure(list({ [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("include_closed is an argument of list, not item_list", async () => {
    const installed = useFake([])
    const error = await failure(list({ include_closed: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('"include_closed"')
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each(["", "  "])("a blank project %p fails before anything is asked of GitHub", async (project) => {
    const installed = useFake([])
    expect((await failure(list({ project }))).code).toBe("invalid_argument")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("a board that no title finds is not_found, and no item is read", async () => {
    const installed = useFake([
      linkedBoardsRule("octo", "hello", []),
      ownerBoardsRule("organization", "octo", []),
      viewerBoardsRule([]),
    ])
    const error = await failure(list({ project: "nonsense" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('"nonsense"')
    expect(apiCalls(installed).some((args) => args.join(" ").includes("items(first"))).toBe(false)
  })
})
