import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  fieldsRule,
  namedBoardRule,
  octoBoardRules,
  ownerTypeRule,
  rawUserBoard,
  viewsRule,
} from "../../testing/project-fixtures"
import {
  graphqlFieldNodes,
  mutationsSent,
  queryOf,
  restFieldsRule,
  restViewRule,
  restWrites,
  updateViewRule,
  userIdRule,
  writeLog,
} from "../../testing/setup-fixtures"
import { sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { projectViewEnsure } from "./view-ensure"

const { use, run } = writeHarness(projectViewEnsure)

const BOARD = { project: "octo/3" }
const FIELDS = ["Title", "Assignees", "Status", "Start", "Target", "Sub-issues progress"]
const EXISTING = { id: "V1", number: 1, name: "Backlog", layout: "TABLE_LAYOUT", filter: null }
const VERSION = "X-GitHub-Api-Version: 2026-03-10"
const SUMMARY = { number: 3, title: "Roadmap", url: "https://github.com/orgs/octo/projects/3", owner: "octo" }

const orgRules = () => [
  ...octoBoardRules(3),
  viewsRule([EXISTING]),
  restFieldsRule("orgs", "octo", 3, FIELDS),
  fieldsRule(graphqlFieldNodes(FIELDS)),
  restViewRule("orgs/octo/projectsV2/3/views", 7),
  updateViewRule(),
]

describe("a missing view", () => {
  test("is created through REST with the numbers of its fields, sorting and grouping", async () => {
    const installed = use(orgRules())
    const result = await run({
      ...BOARD,
      name: " Kanban ",
      layout: "board",
      filter: "-status:Done",
      fields: ["Assignees", "title", "TITLE"],
      column_by: "status",
      group_by: "Assignees",
      sort_by: "Target",
      sort_desc: true,
    })
    expect(result).toEqual({
      project: SUMMARY,
      view: { number: 7, name: "Kanban", layout: "board" },
      created: true,
    })
    expect(restWrites(installed)).toEqual([
      {
        args: ["api", "--method", "POST", "-H", VERSION, "orgs/octo/projectsV2/3/views", "--input", "-"],
        body: {
          name: "Kanban",
          layout: "board",
          filter: "-status:Done",
          visible_fields: [2, 1],
          sort_by: [[5, "desc"]],
          group_by: [2],
          vertical_group_by: [3],
        },
      },
    ])
    expect(installed.stdins().find((stdin) => stdin.startsWith("{"))).toBe(
      '{"name":"Kanban","layout":"board","filter":"-status:Done","visible_fields":[2,1],"sort_by":[[5,"desc"]],"group_by":[2],"vertical_group_by":[3]}',
    )
  })

  test("then gets its columns in the requested order, which REST ignores, by one GraphQL update", async () => {
    const installed = use(orgRules())
    await run({ ...BOARD, name: "Kanban", layout: "board", fields: ["Assignees", "Title", "Target"] })
    expect(writeLog(installed)).toEqual(["POST orgs/octo/projectsV2/3/views", "updateProjectV2View"])
    const [update] = mutationsSent(installed)
    expect(queryOf(update!)).toContain(
      'updateProjectV2View(input:{viewId:$view,configuration:{visibleFieldIds:["GF2","GF1","GF5"]}})',
    )
    expect(update).toContain("view=PVTV_7")
  })

  test("a failed reorder says that the view was made and shows in the board's order", async () => {
    const installed = use([updateViewRule({ stderr: "HTTP 502", code: 1 }), ...orgRules()])
    const error = await failure(run({ ...BOARD, name: "Kanban", layout: "table", fields: ["Assignees", "Title"] }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain('The view "Kanban" (number 7) was created')
    expect(error.message).toContain("board's field order")
    expect(restWrites(installed)).toHaveLength(1)
  })

  test("a roadmap sorts ascending by default, carries no visible fields and is not reordered", async () => {
    const installed = use(orgRules())
    await run({ ...BOARD, name: "Roadmap", layout: "roadmap", sort_by: "Start" })
    expect(restWrites(installed)[0]?.body).toEqual({ name: "Roadmap", layout: "roadmap", sort_by: [[4, "asc"]] })
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a view without fields is not reordered, and the fields are not read through GraphQL", async () => {
    const installed = use(orgRules())
    await run({ ...BOARD, name: "Plain", layout: "table" })
    expect(mutationsSent(installed)).toEqual([])
    expect(sent(installed).some((args) => queryOf(args).includes("fields(first"))).toBe(false)
  })

  const userBoardRules = () => [
    ownerTypeRule("alice", "User"),
    namedBoardRule("user", "alice", 3, rawUserBoard(3)),
    viewsRule([]),
    restFieldsRule("users", "alice", 3, FIELDS),
    fieldsRule(graphqlFieldNodes(FIELDS)),
    updateViewRule(),
  ]
  const restCalls = (installed: Parameters<typeof sent>[0]) => sent(installed).filter((args) => args[1] !== "graphql")

  test("a user's board gets its view through the login, as GitHub answers", async () => {
    const installed = use([...userBoardRules(), restViewRule("users/alice/projectsV2/3/views", 8)])
    const result = await run({ project: "alice/3", name: "Plan", layout: "table", fields: ["Title"] })
    expect(result.view).toEqual({ number: 8, name: "Plan", layout: "table" })
    expect(restCalls(installed).slice(-2)).toEqual([
      ["api", "-H", VERSION, "users/alice/projectsV2/3/fields?per_page=100", "--paginate", "--slurp"],
      ["api", "--method", "POST", "-H", VERSION, "users/alice/projectsV2/3/views", "--input", "-"],
    ])
  })

  test("a login route answering 404 is tried again by the user's numeric id", async () => {
    const installed = use([
      ...userBoardRules(),
      { match: "POST .*users/alice/projectsV2/3/views", stderr: "gh: Not Found (HTTP 404)", code: 1 },
      userIdRule("alice", 4242),
      restViewRule("users/4242/projectsV2/3/views", 8),
    ])
    const result = await run({ project: "alice/3", name: "Plan", layout: "table", fields: ["Title"] })
    expect(result.view).toEqual({ number: 8, name: "Plan", layout: "table" })
    expect(restCalls(installed).slice(-3)).toEqual([
      ["api", "--method", "POST", "-H", VERSION, "users/alice/projectsV2/3/views", "--input", "-"],
      ["api", "users/alice", "--jq", ".id"],
      ["api", "--method", "POST", "-H", VERSION, "users/4242/projectsV2/3/views", "--input", "-"],
    ])
  })

  test("a field the board lacks is invalid_argument, and the view is not made", async () => {
    const installed = use(orgRules())
    const error = await failure(
      run({ ...BOARD, name: "X", layout: "table", fields: ["Title", "Nope"], sort_by: "Gone" }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('"Nope", "Gone"')
    expect(error.message).toContain("Sub-issues progress")
    expect(restWrites(installed)).toEqual([])
  })
})

describe("an existing view", () => {
  test("is left as it is, whatever the arguments ask for", async () => {
    const installed = use(orgRules())
    const result = await run({ ...BOARD, name: "BACKLOG", layout: "board", fields: ["Nope"] })
    expect(result).toEqual({ project: SUMMARY, view: { number: 1, name: "Backlog", layout: "table" }, created: false })
    expect(restWrites(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("/fields?"))).toBe(false)
  })
})

describe("the arguments are checked before GitHub is asked", () => {
  test.each([
    ["fields on a roadmap", { layout: "roadmap", fields: ["Title"] }],
    ["column_by on a table", { layout: "table", column_by: "Status" }],
    ["grouping by Sub-issues progress", { layout: "table", group_by: "sub-issues progress" }],
    ["columns by Linked pull requests", { layout: "board", column_by: "Linked pull requests" }],
    ["sort_desc without sort_by", { layout: "table", sort_desc: true }],
    ["a blank name", { name: " ", layout: "table" }],
  ])("%s", async (_what, args) => {
    const installed = use([])
    expect((await failure(run({ ...BOARD, name: "V", ...args }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})

describe("the board", () => {
  test("must be one the viewer may update, or nothing is written", async () => {
    const installed = use([
      ...octoBoardRules(3, { viewerCanUpdate: false }),
      viewsRule([]),
      restViewRule("orgs/octo/projectsV2/3/views"),
    ])
    expect((await failure(run({ ...BOARD, name: "V", layout: "table" }))).code).toBe("forbidden")
    expect(restWrites(installed)).toEqual([])
  })

  test("there is no title argument: the board is the project", () => {
    expect(projectViewEnsure.input.shape).not.toHaveProperty("title")
    expect(projectViewEnsure).toMatchObject({ class: "idempotent", toolset: "projects", targets: { project: "board" } })
    expect(projectViewEnsure.description).toContain("gh auth refresh -s project")
  })
})
