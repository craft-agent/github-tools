import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  commands,
  createdRule,
  milestoneCreatedRule,
  milestonesRule,
  noIssueTypesRule,
  repositoryRule,
  sent,
  writeRules,
  writes,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

const CREATE = ["issue", "create", "--repo", "octo/hello", "--title", "Crash on save", "--body-file", "-"]

describe("creating", () => {
  test("a title alone: the body goes on stdin as empty text, and the result is complete", async () => {
    const installed = use(writeRules(createdRule(7)))
    expect(await run({ title: "Crash on save" })).toEqual({
      repo: "octo/hello",
      issue: { number: 7, url: "https://github.com/octo/hello/issues/7", title: "Crash on save" },
      kind: null,
      milestone: null,
      relations: { parent: null, blocked_by: [] },
      issue_fields: null,
      project: null,
      foreign: false,
      errors: {},
    })
    expect(commands(installed)).toEqual([{ args: CREATE, stdin: "" }])
  })

  test("labels, assignees and the milestone's title follow, and the body goes on stdin", async () => {
    const installed = use(writeRules(createdRule(7), milestonesRule("v1", "v2")))
    const result = await run({
      title: " Crash on save ",
      body: "It crashes.\n\n## Steps\n1. Save",
      labels: ["bug", "help wanted", "bug", " "],
      assignees: ["@me", "bob"],
      milestone: "V2",
    })
    expect(commands(installed)).toEqual([
      {
        args: [
          ...CREATE,
          "--label",
          "bug",
          "--label",
          "help wanted",
          "--assignee",
          "@me",
          "--assignee",
          "bob",
          "--milestone",
          "v2",
        ],
        stdin: "It crashes.\n\n## Steps\n1. Save",
      },
    ])
    expect(result.milestone).toEqual({ number: 2, title: "v2", created: false })
  })

  test("a repo argument names the repository, and --repo says so on every call", async () => {
    const installed = use([
      createdRule(7, "acme/widgets"),
      repositoryRule({ repo: "acme/widgets" }),
      noIssueTypesRule(),
      { match: "^issue edit" },
    ])
    const result = await run({ title: "T", repo: "acme/widgets", parent: "3" })
    expect(result.repo).toBe("acme/widgets")
    expect(result.relations.parent).toBe("acme/widgets#3")
    expect(commands(installed).map((call) => call.args.slice(0, 5))).toEqual([
      ["issue", "create", "--repo", "acme/widgets", "--title"],
      ["issue", "edit", "7", "--repo", "acme/widgets"],
    ])
  })

  test("the permission is read before anything is written", async () => {
    const installed = use(writeRules(createdRule(7), milestonesRule("v1")))
    await run({ title: "T", milestone: "v1" })
    const calls = sent(installed).map((args) => args.join(" "))
    expect(calls[0]).toContain("viewerPermission")
    expect(calls.findIndex((call) => call.includes("milestones"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("issue create")),
    )
  })

  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), createdRule(7), milestonesRule("v1")])
    const error = await failure(run({ title: "T", milestone: "v9", create_milestone: true }))
    expect(error.code).toBe("forbidden")
    expect(writes(installed)).toEqual([])
    expect(sent(installed)).toHaveLength(1)
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), createdRule(7), noIssueTypesRule()])
    expect((await run({ title: "T" })).foreign).toBe(true)
  })
})

describe("the milestone", () => {
  test("a missing one fails before the issue exists, naming create_milestone", async () => {
    const installed = use(writeRules(createdRule(7), milestonesRule("v1")))
    const error = await failure(run({ title: "T", milestone: "v9" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("create_milestone: true")
    expect(commands(installed)).toEqual([])
    expect(writes(installed)).toEqual([])
  })

  test("create_milestone makes it first, then the issue uses it", async () => {
    const installed = use(writeRules(createdRule(7), milestonesRule("v1"), milestoneCreatedRule(4, "v9")))
    const result = await run({ title: "Crash on save", milestone: "v9", create_milestone: true })
    expect(result.milestone).toEqual({ number: 4, title: "v9", created: true })
    expect(writes(installed)).toEqual([
      ["api", "-X", "POST", "repos/octo/hello/milestones", "-f", "title=v9"],
      [...CREATE, "--milestone", "v9"],
    ])
  })
})
