import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import {
  fieldsRule,
  linkedBoardsRule,
  octoBoardRules,
  ownerBoardsRule,
  rawBoard,
  rawUserBoard,
  viewerRule,
  viewsRule,
} from "../../testing/project-fixtures"
import {
  boardOwnerRule,
  fieldMutationRule,
  graphqlFieldNodes,
  mutationRule,
  mutationsSent,
  queryOf,
  rawField,
  rawOption,
  restFieldsRule,
  restViewRule,
  restWrites,
  updateViewRule,
  writeLog,
} from "../../testing/setup-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { projectCreate } from "./create"
import { ROADMAP_NOTE } from "./template"

const { use, run } = writeHarness(projectCreate)

const OWNER = { owner: "octo" }
const SUMMARY = (number: number) => ({
  number,
  title: "Roadmap",
  url: `https://github.com/orgs/octo/projects/${number}`,
  owner: "octo",
})

const TITLE = rawField("F0", "Title", "TITLE")
const DEFAULT_STATUS = rawField("F1", "Status", "SINGLE_SELECT", [
  rawOption("d1", "Todo", "GREEN", "This item hasn't been started"),
  rawOption("d2", "In Progress", "YELLOW", "This is actively being worked on"),
  rawOption("d3", "Done", "PURPLE", "This has been completed"),
])
const REST_FIELDS = [
  "Title",
  "Assignees",
  "Repository",
  "Milestone",
  "Parent issue",
  "Sub-issues progress",
  "Linked pull requests",
  "Status",
  "Start",
  "Target",
]
const VIEW = (number: number, name: string) => ({
  id: `V${number}`,
  number,
  name,
  layout: "TABLE_LAYOUT",
  filter: null,
})

const CREATE = mutationRule("createProjectV2", { createProjectV2: { projectV2: rawBoard(9) } })
const DELETE_VIEW = mutationRule("deleteProjectV2View", { deleteProjectV2View: { clientMutationId: null } })
const LINK = mutationRule("linkProjectV2ToRepository", { linkProjectV2ToRepository: { repository: { id: "R_1" } } })
const UPDATE_STATUS = fieldMutationRule("updateProjectV2Field", rawField("F1", "Status", "SINGLE_SELECT", []))
const CREATE_DATES = [
  fieldMutationRule("createProjectV2Field", rawField("F8", "Start", "DATE"), "Start"),
  fieldMutationRule("createProjectV2Field", rawField("F9", "Target", "DATE"), "Target"),
]
const REST_SETUP = [restFieldsRule("orgs", "octo", 9, REST_FIELDS), restViewRule("orgs/octo/projectsV2/9/views")]

/** The rules of a call that makes the board: GitHub's own default Status and View 1 are on it. */
const freshRules = (...more: GhRule[]) => [
  ...more,
  boardOwnerRule("octo", "Organization"),
  ownerBoardsRule("organization", "octo", []),
  CREATE,
  { ...fieldsRule([TITLE, DEFAULT_STATUS]), times: 1 },
  fieldsRule(graphqlFieldNodes(REST_FIELDS)),
  UPDATE_STATUS,
  ...CREATE_DATES,
  viewsRule([VIEW(1, "View 1")]),
  ...REST_SETUP,
  updateViewRule(),
  DELETE_VIEW,
]

const BODIES = [
  { name: "Roadmap", layout: "roadmap", filter: "-status:Cancelled", sort_by: [[9, "asc"]] },
  {
    name: "Kanban",
    layout: "board",
    filter: "-status:Done -status:Cancelled",
    visible_fields: [1, 2, 3, 5, 10],
    sort_by: [[10, "asc"]],
    vertical_group_by: [8],
  },
  {
    name: "Backlog",
    layout: "table",
    filter: "-status:Done -status:Cancelled",
    visible_fields: [1, 8, 2, 3, 4, 5, 6, 9, 10, 7],
    sort_by: [[10, "asc"]],
    group_by: [8],
  },
]

describe("a board that has to be made", () => {
  test("is made, brought to the standard template, and loses GitHub's default view", async () => {
    const installed = use(freshRules())
    expect(await run(OWNER)).toEqual({
      project: SUMMARY(9),
      created: true,
      copied_from: null,
      fields: [
        {
          field: "Status",
          created: false,
          added_options: ["Waiting", "Cancelled"],
          updated_options: ["Todo", "In Progress", "Done"],
        },
        { field: "Start", created: true, added_options: [], updated_options: [] },
        { field: "Target", created: true, added_options: [], updated_options: [] },
      ],
      views: [
        { view: "Roadmap", created: true },
        { view: "Kanban", created: true },
        { view: "Backlog", created: true },
      ],
      deleted_default_view: true,
      linked: null,
      notes: [ROADMAP_NOTE],
      errors: {},
    })
    expect(writeLog(installed)).toEqual([
      "createProjectV2",
      "updateProjectV2Field",
      "createProjectV2Field",
      "createProjectV2Field",
      "POST orgs/octo/projectsV2/9/views",
      "POST orgs/octo/projectsV2/9/views",
      "updateProjectV2View",
      "POST orgs/octo/projectsV2/9/views",
      "updateProjectV2View",
      "deleteProjectV2View",
    ])
    expect(restWrites(installed).map((write) => write.body)).toEqual(BODIES)
    const named = (name: string) => mutationsSent(installed).filter((args) => queryOf(args).includes(`${name}(input`))
    expect(named("createProjectV2")[0]).toEqual(expect.arrayContaining(["owner=O_octo", "title=Roadmap"]))
    expect(named("deleteProjectV2View")[0]).toContain("view=V1")
  })

  test("orders the columns of the views that show fields, in the order the template names them", async () => {
    const installed = use(freshRules())
    await run(OWNER)
    const updates = mutationsSent(installed).filter((args) => queryOf(args).includes("updateProjectV2View(input"))
    expect(updates.map((args) => /visibleFieldIds:(\[[^\]]*\])/.exec(queryOf(args))?.[1])).toEqual([
      '["GF1","GF2","GF3","GF5","GF10"]',
      '["GF1","GF8","GF2","GF3","GF4","GF5","GF6","GF9","GF10","GF7"]',
    ])
    expect(updates.map((args) => args.find((arg) => arg.startsWith("view=")))).toEqual(["view=PVTV_5", "view=PVTV_5"])
    // The board's fields are read for the views once, not once per view: the first read is the fields step's.
    expect(sent(installed).filter((args) => queryOf(args).includes("fields(first"))).toHaveLength(2)
  })

  test("a view whose columns could not be ordered still exists: it is reported, with the views step's error", async () => {
    const installed = use([updateViewRule({ stderr: "HTTP 502", code: 1 }), ...freshRules()])
    const result = await run(OWNER)
    expect(result.views).toEqual([
      { view: "Roadmap", created: true },
      { view: "Kanban", created: true },
    ])
    expect(Object.keys(result.errors)).toEqual(["views"])
    expect(result.errors.views).toContain('The view "Kanban" (number 5) was created')
    expect(result.deleted_default_view).toBe(false)
    expect(writeLog(installed).filter((entry) => entry.startsWith("POST"))).toHaveLength(2)
  })

  test("gets exactly the standard Status options, the ids of GitHub's own kept", async () => {
    const installed = use(freshRules())
    await run(OWNER)
    const update = mutationsSent(installed).find((args) => queryOf(args).includes("updateProjectV2Field"))!
    expect(queryOf(update)).toContain(
      'singleSelectOptions:[{id:"d1",name:"Todo",color:BLUE,description:"Ready to start; nothing is in the way."},' +
        '{id:"d2",name:"In Progress",color:YELLOW,description:"Being worked on now."},' +
        '{name:"Waiting",color:GRAY,description:"Cannot move until something else clears: an open blocking issue, a review or a reply."},' +
        '{id:"d3",name:"Done",color:PURPLE,description:"Finished."},' +
        '{name:"Cancelled",color:RED,description:"Will not be done; kept for the record."}]',
    )
    expect(update).toContain("field=F1")
  })

  test("a failing step is reported beside the board, and the later steps still run", async () => {
    const installed = use([
      { match: "^api --method POST", stderr: "HTTP 422: Validation Failed", code: 1 },
      repositoryRule(),
      LINK,
      ...freshRules(),
    ])
    const result = await run({ ...OWNER, link_repo: "octo/hello" })
    expect(result.project).toEqual(SUMMARY(9))
    expect(result.created).toBe(true)
    expect(result.fields).toHaveLength(3)
    expect(result.views).toEqual([])
    expect(result.deleted_default_view).toBe(false)
    expect(result.linked).toBe("octo/hello")
    expect(Object.keys(result.errors)).toEqual(["views"])
    expect(result.errors.views).toContain("HTTP 422")
    expect(writeLog(installed)).not.toContain("deleteProjectV2View")
    expect(writeLog(installed).at(-1)).toBe("linkProjectV2ToRepository")
  })

  test("a failed default view deletion is the default_view step's, not the call's", async () => {
    use([{ match: "deleteProjectV2View", stderr: "HTTP 403", code: 1 }, ...freshRules()])
    const result = await run(OWNER)
    expect(result.deleted_default_view).toBe(false)
    expect(Object.keys(result.errors)).toEqual(["default_view"])
    expect(result.views).toHaveLength(3)
  })

  test("a template is copied without its drafts, and nothing of it is rewritten or deleted", async () => {
    const copy = mutationRule("copyProjectV2", { copyProjectV2: { projectV2: rawBoard(9) } })
    const status = rawField(
      "F1",
      "Status",
      "SINGLE_SELECT",
      ["Todo", "In Progress", "Waiting", "Done", "Cancelled"].map((name) => rawOption(name, name)),
    )
    const installed = use([
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", []),
      ...octoBoardRules(2),
      copy,
      fieldsRule([TITLE, status, rawField("F8", "Start", "DATE"), rawField("F9", "Target", "DATE")]),
      viewsRule([VIEW(1, "View 1"), VIEW(2, "Roadmap"), VIEW(3, "Kanban"), VIEW(4, "Backlog")]),
    ])
    const result = await run({ ...OWNER, template: "octo/2" })
    expect(result).toMatchObject({
      created: true,
      copied_from: "octo/projects/2",
      deleted_default_view: false,
      notes: [],
      errors: {},
    })
    expect(result.fields.map((field) => [field.created, field.added_options, field.updated_options])).toEqual([
      [false, [], []],
      [false, [], []],
      [false, [], []],
    ])
    expect(result.views.map((view) => view.created)).toEqual([false, false, false])
    expect(writeLog(installed)).toEqual(["copyProjectV2"])
    const [call] = mutationsSent(installed)
    expect(queryOf(call!)).toContain("includeDraftIssues:false")
    expect(call).toEqual(expect.arrayContaining(["project=PVT_2", "owner=O_octo"]))
  })

  test("standard: false makes the bare board and reads nothing else", async () => {
    const installed = use([boardOwnerRule("octo", "Organization"), ownerBoardsRule("organization", "octo", []), CREATE])
    const result = await run({ ...OWNER, title: " Plan ", standard: false })
    expect(result).toMatchObject({
      created: true,
      fields: [],
      views: [],
      deleted_default_view: false,
      notes: [],
      errors: {},
    })
    expect(writeLog(installed)).toEqual(["createProjectV2"])
    expect(mutationsSent(installed)[0]).toContain("title=Plan")
  })

  test("a closed board of that title does not count", async () => {
    use([
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(4, { closed: true })]),
      CREATE,
    ])
    expect((await run({ ...OWNER, standard: false })).created).toBe(true)
  })

  test("@me is the viewer: their user, their boards", async () => {
    const created = mutationRule("createProjectV2", { createProjectV2: { projectV2: rawUserBoard(9) } })
    const installed = use([
      viewerRule("alice"),
      boardOwnerRule("alice", "User", "U_1"),
      ownerBoardsRule("user", "alice", []),
      created,
    ])
    const result = await run({ owner: "@me", standard: false })
    expect(result.project).toMatchObject({ owner: "alice", number: 9 })
    expect(mutationsSent(installed)[0]).toContain("owner=U_1")
  })

  test("a user's board gets its views through the login", async () => {
    const created = mutationRule("createProjectV2", { createProjectV2: { projectV2: rawUserBoard(9) } })
    const installed = use([
      boardOwnerRule("alice", "User", "U_1"),
      ownerBoardsRule("user", "alice", []),
      created,
      {
        ...fieldsRule([TITLE, DEFAULT_STATUS, rawField("F8", "Start", "DATE"), rawField("F9", "Target", "DATE")]),
        times: 1,
      },
      fieldsRule(graphqlFieldNodes(REST_FIELDS)),
      UPDATE_STATUS,
      viewsRule([]),
      restFieldsRule("users", "alice", 9, REST_FIELDS),
      restViewRule("users/alice/projectsV2/9/views"),
      updateViewRule(),
    ])
    const result = await run({ owner: "alice" })
    expect(result.views.map((view) => view.created)).toEqual([true, true, true])
    expect(writeLog(installed).filter((entry) => entry.startsWith("POST"))).toEqual(
      BODIES.map(() => "POST users/alice/projectsV2/9/views"),
    )
  })
})

describe("a board that exists", () => {
  const status = rawField("F1", "Status", "SINGLE_SELECT", [
    rawOption("o1", "Todo", "GREEN", "Mine"),
    rawOption("o2", "Done", "PURPLE"),
  ])
  const existingRules = (...more: GhRule[]) => [
    ...more,
    boardOwnerRule("octo", "Organization"),
    ownerBoardsRule("organization", "octo", [rawBoard(4)]),
    { ...fieldsRule([TITLE, status, rawField("F8", "Start", "DATE")]), times: 1 },
    fieldsRule(graphqlFieldNodes(REST_FIELDS)),
    fieldMutationRule("updateProjectV2Field", rawField("F1", "Status", "SINGLE_SELECT", [])),
    fieldMutationRule("createProjectV2Field", rawField("F9", "Target", "DATE")),
    viewsRule([VIEW(1, "View 1"), VIEW(2, "ROADMAP")]),
    restFieldsRule("orgs", "octo", 4, REST_FIELDS),
    restViewRule("orgs/octo/projectsV2/4/views"),
    updateViewRule(),
    DELETE_VIEW,
    CREATE,
  ]

  test("is reused, whatever the case of the title: only what it lacks is added and nothing is deleted", async () => {
    const installed = use(existingRules())
    const result = await run({ ...OWNER, title: " roadmap ", template: "octo/2" })
    expect(result).toEqual({
      project: SUMMARY(4),
      created: false,
      copied_from: null,
      fields: [
        {
          field: "Status",
          created: false,
          added_options: ["In Progress", "Waiting", "Cancelled"],
          updated_options: [],
        },
        { field: "Start", created: false, added_options: [], updated_options: [] },
        { field: "Target", created: true, added_options: [], updated_options: [] },
      ],
      views: [
        { view: "Roadmap", created: false },
        { view: "Kanban", created: true },
        { view: "Backlog", created: true },
      ],
      deleted_default_view: false,
      linked: null,
      notes: [],
      errors: {},
    })
    expect(writeLog(installed)).toEqual([
      "updateProjectV2Field",
      "createProjectV2Field",
      "POST orgs/octo/projectsV2/4/views",
      "updateProjectV2View",
      "POST orgs/octo/projectsV2/4/views",
      "updateProjectV2View",
    ])
    const update = mutationsSent(installed).find((args) => queryOf(args).includes("updateProjectV2Field"))!
    expect(queryOf(update)).toContain(
      'singleSelectOptions:[{id:"o1",name:"Todo",color:GREEN,description:"Mine"},{id:"o2",name:"Done",color:PURPLE,description:""},{name:"In Progress",color:YELLOW,description:"Being worked on now."},',
    )
    expect(restWrites(installed).map((write) => (write.body as { name: string }).name)).toEqual(["Kanban", "Backlog"])
  })

  test("several open boards of that title are invalid_argument, naming them", async () => {
    const installed = use([
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(4), rawBoard(5)]),
      CREATE,
    ])
    const error = await failure(run(OWNER))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("octo/projects/4, octo/projects/5")
    expect(writeLog(installed)).toEqual([])
  })

  test("must be one the viewer may update", async () => {
    const installed = use([
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(4, { viewerCanUpdate: false })]),
      CREATE,
    ])
    expect((await failure(run(OWNER))).code).toBe("forbidden")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("link_repo", () => {
  const bare = (...more: GhRule[]) => [
    ...more,
    repositoryRule(),
    LINK,
    boardOwnerRule("octo", "Organization"),
    ownerBoardsRule("organization", "octo", []),
    CREATE,
  ]

  test("links a board that was just made, without asking what it is linked to", async () => {
    const installed = use(bare())
    const result = await run({ ...OWNER, standard: false, link_repo: "octo/hello" })
    expect(result.linked).toBe("octo/hello")
    expect(writeLog(installed)).toEqual(["createProjectV2", "linkProjectV2ToRepository"])
    expect(mutationsSent(installed)[1]).toEqual(expect.arrayContaining(["project=PVT_9", "repo=R_1"]))
    expect(sent(installed).some((args) => queryOf(args).includes("owner{__typename login} projectsV2"))).toBe(false)
  })

  test("leaves a reused board that is already linked as it is", async () => {
    const installed = use([
      linkedBoardsRule("octo", "hello", [rawBoard(4)]),
      repositoryRule(),
      LINK,
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(4)]),
    ])
    const result = await run({ ...OWNER, standard: false, link_repo: "octo/hello" })
    expect(result).toMatchObject({ created: false, linked: "octo/hello" })
    expect(writeLog(installed)).toEqual([])
  })

  test("links a reused board that is not linked yet", async () => {
    const installed = use([
      linkedBoardsRule("octo", "hello", []),
      repositoryRule(),
      LINK,
      boardOwnerRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(4)]),
    ])
    await run({ ...OWNER, standard: false, link_repo: "octo/hello" })
    expect(writeLog(installed)).toEqual(["linkProjectV2ToRepository"])
  })

  test("a repository of another owner is invalid_argument, before anything is read or written", async () => {
    const installed = use(bare())
    const error = await failure(run({ ...OWNER, link_repo: "Acme/widgets" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "A board can only be linked to a repository of its own owner: the board to be created belongs to octo, Acme/widgets to Acme.",
    )
    expect(sent(installed)).toEqual([])
  })

  test("@me stands for the viewer's login in that check", async () => {
    const installed = use([viewerRule("alice"), ...bare()])
    const error = await failure(run({ owner: "@me", link_repo: "octo/hello" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("belongs to alice, octo/hello to octo")
    expect(writeLog(installed)).toEqual([])
    expect(sent(installed)).toHaveLength(1)
  })

  test("needs write permission, checked before the board is made", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), ...bare()])
    expect((await failure(run({ ...OWNER, link_repo: "octo/hello" }))).code).toBe("forbidden")
    expect(writeLog(installed)).toEqual([])
    expect(sent(installed)).toHaveLength(1)
  })
})

describe("the arguments", () => {
  test.each([
    ["a blank owner", { owner: " " }],
    ["an owner that is no login", { owner: "not a login" }],
    ["a blank title", { owner: "octo", title: " " }],
    ["a repository that is none", { owner: "octo", link_repo: "nope" }],
  ])("%s is invalid_argument, and nothing is asked of GitHub", async (_what, args) => {
    const installed = use([])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("an owner that does not exist is not_found", async () => {
    use([{ match: "repositoryOwner", stdout: JSON.stringify({ data: { repositoryOwner: null } }) }])
    expect((await failure(run(OWNER))).code).toBe("not_found")
  })

  test("names the board to be made, and the repository to link, as what it writes to", () => {
    expect(projectCreate).toMatchObject({
      class: "idempotent",
      toolset: "projects",
      targets: { owner: "owner", link_repo: "repo" },
    })
    expect(projectCreate.description).toContain("gh auth refresh -s project")
  })
})
