import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { LABEL_ROW, labelPages, restFailure, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { labelCreate } from "./label-create"

const { use, run } = writeHarness(labelCreate)
const made = (name = "-Bug") => ({
  match: "-X POST",
  stdout: JSON.stringify({ ...LABEL_ROW, name, url: "https://api.github.com/repos/octo/hello/labels/-Bug" }),
})

test("POST safely creates a dash-prefixed trimmed name, stripping # but keeping GitHub's color", async () => {
  const installed = use([repositoryRule(), labelPages([]), made()])
  expect(await run({ name: " -Bug ", color: "#D73A4A", description: LABEL_ROW.description })).toEqual({
    repo: "octo/hello",
    label: { ...LABEL_ROW, name: "-Bug" },
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "POST", "repos/octo/hello/labels", "--input", "-"],
      body: { name: "-Bug", color: "D73A4A", description: LABEL_ROW.description },
    },
  ])
})

test("optional fields are omitted; explicit repo and foreign are reported", async () => {
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    labelPages([]),
    { match: "-X POST", stdout: JSON.stringify({ name: "Bug", color: "ABCDEF", description: null }) },
  ])
  expect(await run({ repo: "other/thing", name: "Bug" })).toEqual({
    repo: "other/thing",
    label: { name: "Bug", color: "ABCDEF", description: "" },
    foreign: true,
  })
  expect(writeLog(installed)[0]).toEqual({
    args: ["api", "-X", "POST", "repos/other/thing/labels", "--input", "-"],
    body: { name: "Bug" },
  })
})

test("duplicate names are refused without regard to case, across pages", async () => {
  const installed = use([repositoryRule(), labelPages([], "next", 1), labelPages([LABEL_ROW]), made()])
  const error = await failure(run({ name: "BUG" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('octo/hello has the label "Bug" already; change it with github_label_edit.')
  expect(writeLog(installed)).toEqual([])
})

test.each([{ name: " " }, { name: "Bug", color: "12345" }, { name: "Bug", color: "#gggggg" }])(
  "invalid arguments %p send no write",
  async (args) => {
    const installed = use([])
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(writeLog(installed)).toEqual([])
  },
)

test("GitHub's HTTP 422 is invalid_argument with GitHub's own words", async () => {
  use([
    repositoryRule(),
    labelPages([]),
    restFailure("-X POST", "Validation Failed (HTTP 422)", { errors: ["color is invalid"] }),
  ])
  const error = await failure(run({ name: "Bug" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("GitHub refused it: Validation Failed: color is invalid.")
})

test("another failed write keeps its code", async () => {
  use([repositoryRule(), labelPages([]), restFailure("-X POST", "Server Error (HTTP 500)")])
  expect((await failure(run({ name: "Bug" }))).code).toBe("upstream_error")
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" }), labelPages([]), made()])
  expect((await failure(run({ name: "Bug" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})
