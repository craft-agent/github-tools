import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { MILESTONE_ROW, milestonePages, milestoneRest, writeLog } from "../../testing/repos-fixtures"
import { milestonesRule, repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { milestoneEdit } from "./milestone-edit"

const { use, run } = writeHarness(milestoneEdit)
const edited = (overrides = {}) => ({ match: "-X PATCH", stdout: JSON.stringify(milestoneRest(overrides)) })

test("PATCH changes all fields and returns GitHub's milestone", async () => {
  const installed = use([
    repositoryRule(),
    milestonePages([MILESTONE_ROW]),
    edited({ title: "v2", due_on: "2028-02-29T12:00:00Z", description: "", state: "closed" }),
  ])
  expect(await run({ milestone: 1, title: "v2", due: "2028-02-29", description: "", state: "closed" })).toEqual({
    repo: "octo/hello",
    milestone: { number: 1, title: "v2", due: "2028-02-29", description: "", state: "closed", url: MILESTONE_ROW.url },
    changed: ["title", "due", "description", "state"],
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/milestones/1", "--input", "-"],
      body: { title: "v2", due_on: "2028-02-29T12:00:00Z", description: "", state: "closed" },
    },
  ])
})

test("title matches case-insensitively in closed state and clear_due sends null", async () => {
  const installed = use([
    repositoryRule(),
    milestonePages([{ ...MILESTONE_ROW, state: "CLOSED" }]),
    milestonesRule("Release"),
    edited({ state: "closed", due_on: null }),
  ])
  expect(await run({ milestone: "RELEASE", clear_due: true })).toMatchObject({
    milestone: { state: "closed", due: null },
    changed: ["due"],
  })
  expect(writeLog(installed)[0]!.body).toEqual({ due_on: null })
})

test("unchanged fields are omitted; a numeric string resolves by number", async () => {
  const installed = use([repositoryRule(), milestonePages([MILESTONE_ROW]), edited({ description: "" })])
  expect(
    (await run({ milestone: "1", title: "Release", due: "2026-12-01", state: "open", description: "" })).changed,
  ).toEqual(["description"])
  expect(writeLog(installed)[0]!.body).toEqual({ description: "" })
})

test("same values are a no-op", async () => {
  const installed = use([repositoryRule(), milestonePages([MILESTONE_ROW]), edited()])
  expect(
    await run({ milestone: 1, title: "Release", due: "2026-12-01", description: "Next release", state: "open" }),
  ).toEqual({
    repo: "octo/hello",
    milestone: {
      number: 1,
      title: "Release",
      state: "open",
      due: "2026-12-01",
      description: "Next release",
      url: MILESTONE_ROW.url,
    },
    changed: [],
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([])
})

test("clearing an absent due date is a no-op", async () => {
  const installed = use([repositoryRule(), milestonePages([{ ...MILESTONE_ROW, dueOn: null }]), edited()])
  expect((await run({ milestone: 1, clear_due: true })).changed).toEqual([])
  expect(writeLog(installed)).toEqual([])
})

test("case-only changes to this title are allowed", async () => {
  const installed = use([repositoryRule(), milestonePages([MILESTONE_ROW]), edited({ title: "RELEASE" })])
  expect((await run({ milestone: 1, title: "RELEASE" })).changed).toEqual(["title"])
  expect(writeLog(installed)[0]!.body).toEqual({ title: "RELEASE" })
})

test.each([
  [
    { milestone: 1 },
    "invalid_argument",
    "Pass at least one of title, due, clear_due, description or state to change the milestone.",
  ],
  [
    { milestone: 1, clear_due: false },
    "invalid_argument",
    "Pass at least one of title, due, clear_due, description or state to change the milestone.",
  ],
  [{ milestone: 1, due: "2026-12-01", clear_due: true }, "invalid_argument", "Pass due or clear_due, not both."],
  [{ milestone: 1, due: "2026-12-01", clear_due: false }, "invalid_argument", "Pass due or clear_due, not both."],
  [{ milestone: "missing", description: "" }, "not_found", 'Milestone "missing" was not found.'],
  [{ milestone: 99, description: "" }, "not_found", 'Milestone "99" was not found.'],
  [{ milestone: 1, title: "OTHER" }, "invalid_argument", 'octo/hello has another milestone titled "OTHER" already.'],
] as const)("refuses %p without writing", async (args, code, message) => {
  const installed = use([
    repositoryRule(),
    milestonePages([MILESTONE_ROW, { ...MILESTONE_ROW, number: 2, title: "Other", state: "CLOSED" }]),
    milestonesRule("Release", "Other"),
    edited(),
  ])
  const error = await failure(run(args))
  expect(error.code).toBe(code)
  expect(error.message).toBe(message)
  expect(writeLog(installed)).toEqual([])
})

test.each([
  { milestone: 1, due: "2026-02-29" },
  { milestone: 1, title: " " },
  { milestone: 1, state: "all" },
])("invalid edit %p writes nothing", async (args) => {
  const installed = use([])
  expect((await failure(run(args))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ milestone: 1, description: "" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("explicit foreign repository", async () => {
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    milestonePages([MILESTONE_ROW]),
    edited({ description: "" }),
  ])
  expect(await run({ repo: "other/thing", milestone: 1, description: "" })).toMatchObject({
    repo: "other/thing",
    foreign: true,
  })
  expect(writeLog(installed)[0]!.args).toContain("repos/other/thing/milestones/1")
})
