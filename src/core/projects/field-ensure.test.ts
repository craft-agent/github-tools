import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { fieldsRule, octoBoardRules } from "../../testing/project-fixtures"
import { fieldMutationRule, mutationsSent, queryOf, rawField, rawOption } from "../../testing/setup-fixtures"
import { sent } from "../../testing/write-fixtures"
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
      field: { id: "F9", name: "Estimate", type: "number" },
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
