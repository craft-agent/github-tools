import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { MILESTONE_ROW, milestonePages, milestoneRest, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { milestoneCreate } from "./milestone-create"

const { use, run } = writeHarness(milestoneCreate)
const created = { match: "-X POST", stdout: JSON.stringify(milestoneRest()) }

test("POST returns a milestone and sends noon UTC for a real date", async () => {
  const installed = use([repositoryRule(), milestonePages([]), created])
  expect(await run({ title: " Release ", due: "2026-12-01", description: "Next release" })).toEqual({
    repo: "octo/hello",
    milestone: {
      number: 1,
      title: "Release",
      state: "open",
      due: "2026-12-01",
      description: "Next release",
      url: MILESTONE_ROW.url,
    },
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "POST", "repos/octo/hello/milestones", "--input", "-"],
      body: { title: "Release", due_on: "2026-12-01T12:00:00Z", description: "Next release" },
    },
  ])
})

test("optional fields are omitted and null descriptions/dates become empty/null", async () => {
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    milestonePages([]),
    { match: "-X POST", stdout: JSON.stringify(milestoneRest({ description: null, due_on: null })) },
  ])
  expect(await run({ repo: "other/thing", title: "Release" })).toMatchObject({
    repo: "other/thing",
    milestone: { due: null, description: "" },
    foreign: true,
  })
  expect(writeLog(installed)[0]).toEqual({
    args: ["api", "-X", "POST", "repos/other/thing/milestones", "--input", "-"],
    body: { title: "Release" },
  })
})

test.each(["OPEN", "CLOSED"])("duplicate title in state %s is refused without regard to case", async (state) => {
  const installed = use([repositoryRule(), milestonePages([{ ...MILESTONE_ROW, state }]), created])
  const error = await failure(run({ title: "RELEASE" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('octo/hello has the milestone "Release" already; change it with github_milestone_edit.')
  expect(writeLog(installed)).toEqual([])
})

test.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-12-01T00:00:00Z"])(
  "invalid date %s writes nothing",
  async (due) => {
    const installed = use([])
    expect((await failure(run({ title: "Release", due }))).code).toBe("invalid_argument")
    expect(writeLog(installed)).toEqual([])
  },
)

test("a real leap day is accepted", async () => {
  const installed = use([repositoryRule(), milestonePages([]), created])
  await run({ title: "Release", due: "2028-02-29" })
  expect(writeLog(installed)[0]!.body).toEqual({ title: "Release", due_on: "2028-02-29T12:00:00Z" })
})

test("blank title writes nothing", async () => {
  const installed = use([])
  expect((await failure(run({ title: " " }))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ title: "Release" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("duplicate checks still cover milestones beyond the read tool's scan limit", async () => {
  const installed = use([
    repositoryRule(),
    milestonePages(
      Array.from({ length: 1000 }, (_, index) => ({
        ...MILESTONE_ROW,
        number: index + 1,
        title: `Milestone ${index}`,
      })),
      "next",
    ),
    { match: "milestones\\?state=all", stdout: JSON.stringify([[milestoneRest({ number: 1001, state: "closed" })]]) },
    created,
  ])
  const error = await failure(run({ title: "RELEASE" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('octo/hello has the milestone "Release" already; change it with github_milestone_edit.')
  expect(writeLog(installed)).toEqual([])
})
