import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { graphqlCalls, graphqlRule, page, repositoryReply } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { milestoneRead } from "./milestone-read"

const { use, run } = writeHarness(milestoneRead)

const MILESTONES = "milestones\\(first:100"

const raw = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `v${number}`,
  state: "OPEN",
  dueOn: null,
  description: null,
  progressPercentage: 0,
  openIssueCount: 0,
  closedIssueCount: 0,
  url: `https://github.com/octo/hello/milestone/${number}`,
  ...extra,
})

const expected = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `v${number}`,
  state: "open" as const,
  due: null,
  description: "",
  progress: 0,
  open_issues: 0,
  closed_issues: 0,
  url: `https://github.com/octo/hello/milestone/${number}`,
  ...extra,
})

const milestonePages = (milestones: unknown[], next: string | null = null, times?: number) =>
  graphqlRule(MILESTONES, { repository: { milestones: page(milestones, next) } }, times)

describe("list", () => {
  test("maps a milestone, with the due date as a day", async () => {
    const installed = use([
      milestonePages([
        raw(3, {
          dueOn: "2026-12-01T00:00:00Z",
          description: "The third",
          progressPercentage: 66.5,
          openIssueCount: 2,
          closedIssueCount: 4,
        }),
      ]),
    ])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      milestones: [
        expected(3, { due: "2026-12-01", description: "The third", progress: 66.5, open_issues: 2, closed_issues: 4 }),
      ],
      truncated: false,
    })
    const [call, ...others] = graphqlCalls(installed)
    expect(others).toEqual([])
    expect(call!.query).toContain("states:[OPEN]")
    expect(call!.query).toContain("orderBy:{field:DUE_DATE,direction:ASC}")
    expect(call!.vars).toEqual({ owner: "octo", name: "hello", after: "null" })
  })

  test.each([
    ["closed", "states:[CLOSED]"],
    ["all", "states:[OPEN,CLOSED]"],
  ])("state %s is sent as %s", async (state, states) => {
    const installed = use([milestonePages([raw(1, { state: "CLOSED" })])])
    const result = await run({ method: "list", state })
    expect(result.milestones[0]!.state).toBe("closed")
    expect(graphqlCalls(installed)[0]!.query).toContain(states)
  })

  test("milestones with no due date come last, in the order GitHub gave them", async () => {
    use([
      milestonePages([
        raw(1),
        raw(2, { dueOn: "2026-12-01T00:00:00Z" }),
        raw(3),
        raw(4, { dueOn: "2026-12-15T00:00:00Z" }),
      ]),
    ])
    const result = await run({ method: "list" })
    expect(result.milestones.map((milestone) => milestone.number)).toEqual([2, 4, 1, 3])
  })

  test("pages are followed before the order is settled", async () => {
    const installed = use([
      milestonePages([raw(1)], "c1", 1),
      milestonePages([raw(2, { dueOn: "2026-12-01T00:00:00Z" })]),
    ])
    const result = await run({ method: "list" })
    expect(result.milestones.map((milestone) => milestone.number)).toEqual([2, 1])
    expect(graphqlCalls(installed).map((call) => call.vars.after)).toEqual(["null", "c1"])
  })

  test("limit cuts the milestones and truncated says more matched", async () => {
    use([milestonePages([raw(1), raw(2), raw(3)])])
    const result = await run({ method: "list", limit: 2 })
    expect(result.milestones.map((milestone) => milestone.number)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
  })

  test("a repository with no milestones lists none", async () => {
    use([milestonePages([])])
    expect(await run({ method: "list", repo: "other/thing" })).toEqual({
      repo: "other/thing",
      milestones: [],
      truncated: false,
    })
  })

  test("a missing repository is not_found", async () => {
    use([{ match: MILESTONES, stdout: repositoryReply(null) }])
    expect((await failure(run({ method: "list" }))).code).toBe("not_found")
  })

  test.each([
    ["limit", 0],
    ["limit", 1001],
    ["state", "merged"],
  ])("invalid %s %p", async (name, value) => {
    use([])
    expect((await failure(run({ method: "list", [name]: value }))).code).toBe("invalid_argument")
  })
})
