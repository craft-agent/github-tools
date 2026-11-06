import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { gqlErrors } from "../../testing/gql"
import { fieldsRule, namedBoardRule, octoBoardRules, ownerTypeRule, rawUserBoard } from "../../testing/project-fixtures"
import {
  fieldMutationRule,
  mutationRule,
  mutationsSent,
  organizationIssueFieldsRule,
  queryOf,
  rawField,
  rawIssueFieldDate,
  rawIssueFieldSingleSelect,
  rawOption,
} from "../../testing/setup-fixtures"
import { ISSUE_FIELD_DEFINITIONS, ISSUE_FIELD_NODES, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { projectFieldEnsure } from "./field-ensure"

const { use, run } = writeHarness(projectFieldEnsure)

const SUMMARY = { number: 3, title: "Roadmap", url: "https://github.com/orgs/octo/projects/3", owner: "octo" }
const STATUS = rawField("F2", "Status", "SINGLE_SELECT", [
  rawOption("o1", "Todo", "GREEN", "Not started"),
  rawOption("o2", "Done", "PURPLE"),
])
const BOARD = { project: "octo/3" }

describe("a missing field", () => {
  test("is created with its type, and nothing else is written", async () => {
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([rawField("F1", "Title", "TITLE")]),
      fieldMutationRule("createProjectV2Field", rawField("F9", "Estimate", "NUMBER")),
    ])
    expect(await run({ ...BOARD, name: " Estimate ", type: "number" })).toEqual({
      project: SUMMARY,
      field: { id: "F9", name: "Estimate", type: "number", issue_field: false },
      created: true,
      added_options: [],
    })
    const [call, ...others] = mutationsSent(installed)
    expect(others).toEqual([])
    expect(queryOf(call!)).toContain("dataType:NUMBER,name:$name}")
    expect(call).toContain("name=Estimate")
    expect(call).toContain("project=PVT_3")
  })

  test("a single select takes its options with their colors and descriptions", async () => {
    const created = rawField("F9", "Size", "SINGLE_SELECT", [rawOption("n1", "S"), rawOption("n2", "L", "RED", "Big")])
    const installed = use([...octoBoardRules(3), fieldsRule([]), fieldMutationRule("createProjectV2Field", created)])
    const result = await run({ ...BOARD, name: "Size", type: "single_select", options: ["S", "L:red:Big"] })
    expect(result).toMatchObject({ created: true, added_options: ["S", "L"] })
    expect(queryOf(mutationsSent(installed)[0]!)).toContain(
      'singleSelectOptions:[{name:"S",color:GRAY,description:""},{name:"L",color:RED,description:"Big"}]',
    )
  })

  test("a single select without options is invalid_argument", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([])])
    expect((await failure(run({ ...BOARD, name: "Size", type: "single_select" }))).code).toBe("invalid_argument")
    expect(mutationsSent(installed)).toEqual([])
  })

  test("Status can be extended, not created", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([])])
    const error = await failure(run({ ...BOARD, name: "status", type: "single_select", options: ["Todo"] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("cannot be created")
    expect(mutationsSent(installed)).toEqual([])
  })
})

describe("an existing field", () => {
  test("a single select gets the missing options appended; the others keep id, color, description and place", async () => {
    const updated = rawField("F2", "Status", "SINGLE_SELECT", [
      rawOption("o1", "Todo", "GREEN", "Not started"),
      rawOption("o2", "Done", "PURPLE"),
      rawOption("o3", "Waiting", "GRAY", "Stuck"),
    ])
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([STATUS]),
      fieldMutationRule("updateProjectV2Field", updated),
    ])
    const result = await run({
      ...BOARD,
      name: "STATUS",
      type: "single_select",
      options: ["todo:RED", "Waiting:GRAY:Stuck"],
    })
    expect(result.created).toBe(false)
    expect(result.added_options).toEqual(["Waiting"])
    expect(result.field.options?.map((option) => option.name)).toEqual(["Todo", "Done", "Waiting"])
    const [call] = mutationsSent(installed)
    expect(queryOf(call!)).toContain(
      'singleSelectOptions:[{id:"o1",name:"Todo",color:GREEN,description:"Not started"},{id:"o2",name:"Done",color:PURPLE,description:""},{name:"Waiting",color:GRAY,description:"Stuck"}]',
    )
    expect(call).toContain("field=F2")
  })

  test("nothing missing writes nothing", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([STATUS])])
    const result = await run({ ...BOARD, name: "Status", type: "single_select", options: ["DONE"] })
    expect(result).toMatchObject({ created: false, added_options: [], field: { id: "F2" } })
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a field of another type is invalid_argument", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([STATUS])])
    const error = await failure(run({ ...BOARD, name: "Status", type: "text" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("single_select, not text")
    expect(mutationsSent(installed)).toEqual([])
  })

  test("refuses changing options of a mirrored issue field column", async () => {
    const priority = rawIssueFieldSingleSelect("F_priority", "Priority", [
      rawOption("p1", "High"),
      rawOption("p2", "Low"),
    ])
    const installed = use([...octoBoardRules(3), fieldsRule([priority])])
    const error = await failure(run({ ...BOARD, name: "Priority", type: "single_select", options: ["Urgent"] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "\"Priority\" mirrors the organization's issue field; its options are the organization's and cannot be changed on a board.",
    )
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a mirrored issue field column without option changes returns unchanged without writing", async () => {
    const priority = rawIssueFieldSingleSelect("F_priority", "Priority", [
      rawOption("p1", "High"),
      rawOption("p2", "Low"),
    ])
    const installed = use([...octoBoardRules(3), fieldsRule([priority])])
    const result = await run({ ...BOARD, name: "Priority", type: "single_select", options: ["HIGH"] })
    expect(result).toMatchObject({
      created: false,
      added_options: [],
      field: { id: "F_priority", name: "Priority", type: "single_select", issue_field: true },
    })
    expect(mutationsSent(installed)).toEqual([])
  })
})

describe("an issue field column", () => {
  const TARGET_DATE = rawField("F7", "Target date", "DATE")
  const ADD = "createProjectV2IssueField"
  const addRule = (field: unknown) => mutationRule(ADD, { [ADD]: { projectV2Field: field } })
  const definitionsRule = organizationIssueFieldsRule("octo", ISSUE_FIELD_NODES)
  const read = (installed: ReturnType<typeof use>) => sent(installed).map((args) => queryOf(args))

  test("is added with the issue field's id; its name, type and options are the organization's", async () => {
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([rawField("F1", "Title", "TITLE")]),
      definitionsRule,
      addRule(rawIssueFieldDate("F_target_date", "Target date")),
    ])
    expect(await run({ ...BOARD, name: " target DATE ", issue_field: true })).toEqual({
      project: SUMMARY,
      field: { id: "F_target_date", name: "Target date", type: "date", issue_field: true },
      created: true,
      added_options: [],
    })
    const [call, ...others] = mutationsSent(installed)
    expect(others).toEqual([])
    expect(queryOf(call!)).toContain(`${ADD}(input:{projectId:$project,issueFieldId:$field})`)
    expect(queryOf(call!)).toContain("isIssueField")
    expect(call).toContain("field=IF_target")
    expect(call).toContain("project=PVT_3")
  })

  test("a single select reports the organization's options, and a type that matches is accepted", async () => {
    const created = rawIssueFieldSingleSelect("F_priority", "Priority", [rawOption("IFO_high", "High")])
    const installed = use([...octoBoardRules(3), fieldsRule([]), definitionsRule, addRule(created)])
    const result = await run({ ...BOARD, name: "Priority", type: "single_select", issue_field: true })
    expect(result).toMatchObject({
      created: true,
      added_options: [],
      field: { issue_field: true, type: "single_select", options: [{ id: "IFO_high", name: "High" }] },
    })
    expect(mutationsSent(installed)[0]).toContain("field=IF_priority")
  })

  test("already on the board: returned as it is, and nothing is written", async () => {
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([rawIssueFieldDate("F_target_date", "Target date")]),
      definitionsRule,
    ])
    expect(await run({ ...BOARD, name: "TARGET date", issue_field: true })).toMatchObject({
      created: false,
      added_options: [],
      field: { id: "F_target_date", issue_field: true },
    })
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a field of the board's own with that name is refused before anything is written", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([TARGET_DATE]), definitionsRule])
    const error = await failure(run({ ...BOARD, name: "Target date", issue_field: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "The board has its own field \"Target date\"; an issue field column cannot take the same name. Rename or delete the board's field in the web UI, or use the board's field.",
    )
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a name the organization has no issue field of is refused, listing the ones it has", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([]), definitionsRule])
    const error = await failure(run({ ...BOARD, name: "Start date", issue_field: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'octo has no issue field "Start date". Issue fields: "Priority", "Effort", "Target date", "Sprint", "Components".',
    )
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a type that is not the issue field's is refused", async () => {
    const installed = use([...octoBoardRules(3), fieldsRule([]), definitionsRule])
    const error = await failure(run({ ...BOARD, name: "Priority", type: "date", issue_field: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"Priority" is single_select, not date.')
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a user's board is refused without reading issue fields", async () => {
    const installed = use([
      ownerTypeRule("alice", "User"),
      namedBoardRule("user", "alice", 3, rawUserBoard(3)),
      fieldsRule([]),
    ])
    const error = await failure(run({ project: "alice/3", name: "Target date", issue_field: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("Issue fields belong to an organization; alice is a user.")
    expect(read(installed).some((query) => query.includes("issueFields"))).toBe(false)
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a GitHub without issue fields is refused", async () => {
    const message = "Field 'issueFields' doesn't exist on type 'Organization'"
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([]),
      { match: ISSUE_FIELD_DEFINITIONS, stdout: gqlErrors([{ type: "undefinedField", message }]) },
    ])
    const error = await failure(run({ ...BOARD, name: "Target date", issue_field: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("This GitHub has no issue fields.")
    expect(mutationsSent(installed)).toEqual([])
  })

  test("options are the organization's: giving some is refused before GitHub is asked", async () => {
    const installed = use([])
    const error = await failure(run({ ...BOARD, name: "Priority", issue_field: true, options: ["Urgent"] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("options are the organization's")
    expect(sent(installed)).toEqual([])
  })

  test("a blank name is refused before GitHub is asked", async () => {
    const installed = use([])
    expect((await failure(run({ ...BOARD, name: " ", issue_field: true }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("without issue_field the type is required, before GitHub is asked", async () => {
    const installed = use([])
    for (const args of [{ name: "Estimate" }, { name: "Estimate", issue_field: false }]) {
      const error = await failure(run({ ...BOARD, ...args }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe("type is required unless issue_field is true.")
    }
    expect(sent(installed)).toEqual([])
  })

  test("issue_field false keeps the board's own field path", async () => {
    const installed = use([
      ...octoBoardRules(3),
      fieldsRule([]),
      fieldMutationRule("createProjectV2Field", rawField("F9", "Estimate", "NUMBER")),
    ])
    await run({ ...BOARD, name: "Estimate", type: "number", issue_field: false })
    expect(queryOf(mutationsSent(installed)[0]!)).toContain("createProjectV2Field(")
  })
})

describe("the arguments are checked before GitHub is asked", () => {
  test.each([
    ["a color GitHub does not list", { name: "S", type: "single_select", options: ["A:TEAL"] }],
    ["a repeated option", { name: "S", type: "single_select", options: ["A", "a:RED"] }],
    ["options on a field that is not a single select", { name: "S", type: "text", options: ["A"] }],
    ["a blank name", { name: " ", type: "text" }],
  ])("%s", async (_what, args) => {
    const installed = use([])
    expect((await failure(run({ ...BOARD, ...args }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})

describe("the board", () => {
  test("must be one the viewer may update, or nothing is read or written", async () => {
    const installed = use(octoBoardRules(3, { viewerCanUpdate: false }))
    expect((await failure(run({ ...BOARD, name: "Estimate", type: "number" }))).code).toBe("forbidden")
    expect(sent(installed).some((args) => args.join(" ").includes("fields(first"))).toBe(false)
    expect(mutationsSent(installed)).toEqual([])
  })

  test("there is no title argument: the board is the project", () => {
    expect(projectFieldEnsure.input.shape).not.toHaveProperty("title")
  })
})

describe("the tool", () => {
  test("is an idempotent write of the projects toolset that names its board", () => {
    expect(projectFieldEnsure).toMatchObject({
      class: "idempotent",
      toolset: "projects",
      targets: { project: "board" },
    })
    expect(projectFieldEnsure.description).toContain("gh auth refresh -s project")
  })
})
