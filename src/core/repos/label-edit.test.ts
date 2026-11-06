import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { LABEL_ROW, labelPages, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { labelEdit } from "./label-edit"

const { use, run } = writeHarness(labelEdit)
const after = { name: "Defect", color: "ABCDEF", description: "" }
const edited = { match: "-X PATCH", stdout: JSON.stringify(after) }

test("PATCH matches case-insensitively, URL-encodes the current name, and reports fields", async () => {
  const installed = use([repositoryRule(), labelPages([{ ...LABEL_ROW, name: "Bug / #1?" }]), edited])
  expect(await run({ name: "bug / #1?", new_name: " Defect ", color: "#ABCDEF", description: "" })).toEqual({
    repo: "octo/hello",
    label: after,
    changed: ["name", "color", "description"],
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/labels/Bug%20%2F%20%231%3F", "--input", "-"],
      body: { new_name: "Defect", color: "ABCDEF", description: "" },
    },
  ])
})

test("unchanged fields are not sent", async () => {
  const installed = use([repositoryRule(), labelPages([LABEL_ROW]), edited])
  expect((await run({ name: "bug", new_name: "Bug", color: "#D73A4A", description: "" })).changed).toEqual([
    "description",
  ])
  expect(writeLog(installed)[0]!.body).toEqual({ description: "" })
})

test("same values including color case are a no-op", async () => {
  const installed = use([repositoryRule(), labelPages([LABEL_ROW]), edited])
  expect(await run({ name: "BUG", new_name: "Bug", color: "#D73A4A", description: LABEL_ROW.description })).toEqual({
    repo: "octo/hello",
    label: LABEL_ROW,
    changed: [],
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([])
})

test("changing only the spelling of this label is allowed", async () => {
  const installed = use([
    repositoryRule(),
    labelPages([LABEL_ROW]),
    { match: "-X PATCH", stdout: JSON.stringify({ ...LABEL_ROW, name: "BUG" }) },
  ])
  expect((await run({ name: "bug", new_name: "BUG" })).changed).toEqual(["name"])
  expect(writeLog(installed)[0]!.body).toEqual({ new_name: "BUG" })
})

test.each([
  [{ name: "Bug" }, "invalid_argument", "Pass at least one of new_name, color or description to change the label."],
  [{ name: "missing", color: "123456" }, "not_found", 'Label "missing" was not found.'],
  [{ name: "Bug", new_name: "DOCS" }, "invalid_argument", 'octo/hello has another label named "DOCS" already.'],
] as const)("refuses %p without writing", async (args, code, message) => {
  const installed = use([repositoryRule(), labelPages([LABEL_ROW, { ...LABEL_ROW, name: "Docs" }]), edited])
  const error = await failure(run(args))
  expect(error.code).toBe(code)
  expect(error.message).toBe(message)
  expect(writeLog(installed)).toEqual([])
})

test.each([
  { name: "Bug", new_name: " " },
  { name: "Bug", color: "bad" },
])("invalid edit %p sends no write", async (args) => {
  const installed = use([])
  expect((await failure(run(args))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ name: "Bug", description: "" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("another repository is foreign", async () => {
  use([repositoryRule({ repo: "other/thing", viewer: "me" }), labelPages([LABEL_ROW]), edited])
  expect(await run({ repo: "other/thing", name: "Bug", description: "" })).toMatchObject({
    repo: "other/thing",
    foreign: true,
  })
})
