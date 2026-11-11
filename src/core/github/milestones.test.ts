import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { MILESTONES, milestoneCreatedRule, milestonesRule } from "../../testing/write-fixtures"
import { parseRepo } from "../refs"
import { resolveMilestone } from "./milestones"

const CTX = { cwd: process.cwd() }
const REPO = parseRepo("octo/hello")
const LIST = ["api", "repos/octo/hello/milestones?state=all&per_page=100", "--paginate", "--slurp"]

let fake: FakeGh | undefined

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

afterEach(() => {
  fake?.restore()
  fake = undefined
})

describe("resolveMilestone", () => {
  test("finds a milestone by its title among the open and closed ones", async () => {
    const installed = useFake([milestonesRule("v1", "v2")])
    expect(await resolveMilestone(REPO, "v2", { create: false }, CTX)).toEqual({
      number: 2,
      title: "v2",
      created: false,
    })
    expect(installed.calls().filter((args) => args[0] === "api")).toEqual([LIST])
  })

  test("prefers an exact title, else matches without regard to case, in GitHub's spelling", async () => {
    useFake([milestonesRule("Release", "release")])
    expect(await resolveMilestone(REPO, "release", { create: false }, CTX)).toEqual({
      number: 2,
      title: "release",
      created: false,
    })
    expect(await resolveMilestone(REPO, "RELEASE", { create: false }, CTX)).toEqual({
      number: 1,
      title: "Release",
      created: false,
    })
  })

  test("reads every page", async () => {
    useFake([{ match: MILESTONES, stdout: JSON.stringify([[{ number: 1, title: "a" }], [{ number: 2, title: "b" }]]) }])
    expect((await resolveMilestone(REPO, "b", { create: false }, CTX)).number).toBe(2)
  })

  test("a missing milestone is invalid_argument, naming create_milestone, and nothing is created", async () => {
    const installed = useFake([milestonesRule("v1")])
    const error = await failure(resolveMilestone(REPO, "v9", { create: false }, CTX))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('Milestone "v9" does not exist in octo/hello; pass create_milestone: true to create it.')
    expect(installed.calls().some((args) => args.includes("POST"))).toBe(false)
  })

  test("a missing milestone is created when asked to", async () => {
    const installed = useFake([milestonesRule("v1"), milestoneCreatedRule(7, "v9")])
    expect(await resolveMilestone(REPO, "v9", { create: true }, CTX)).toEqual({ number: 7, title: "v9", created: true })
    expect(installed.calls().at(-1)).toEqual(["api", "-X", "POST", "repos/octo/hello/milestones", "-f", "title=v9"])
  })

  test("an empty list holds no milestone", async () => {
    useFake([{ match: MILESTONES }])
    expect((await failure(resolveMilestone(REPO, "v1", { create: false }, CTX))).code).toBe("invalid_argument")
  })

  test("a reply to the creation without a milestone is upstream_error", async () => {
    useFake([milestonesRule(), { match: "-X POST", stdout: "{}" }])
    expect((await failure(resolveMilestone(REPO, "v1", { create: true }, CTX))).code).toBe("upstream_error")
  })

  test("a failed list is the call's failure", async () => {
    useFake([{ match: MILESTONES, stderr: "HTTP 403: Resource not accessible", code: 1 }])
    expect((await failure(resolveMilestone(REPO, "v1", { create: true }, CTX))).code).toBe("forbidden")
  })
})
