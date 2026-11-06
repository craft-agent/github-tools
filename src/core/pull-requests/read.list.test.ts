import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  SEARCH,
  apiCalls,
  failure,
  pullRequestRow,
  rawRow,
  searchPage,
  searchRule,
  searchedFor,
  variable,
} from "../../testing/pull-request-fixtures"
import { invoke } from "../tool"
import { prRead } from "./read"

let repo: TempRepo
let fake: FakeGh | undefined
beforeEach(() => {
  repo = tempRepo("https://github.com/octo/hello.git")
})
afterEach(() => {
  fake?.restore()
  fake = undefined
  repo.cleanup()
})
function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}
const read = (args: Record<string, unknown>) => invoke(prRead, args, { cwd: repo.dir })

test("default query, limit and mapped rows; non-PR nodes are filtered", async () => {
  const installed = useFake([searchRule([{}, null, rawRow(7)])])
  expect(await read({ method: "list" })).toEqual({
    repo: "octo/hello",
    query: "repo:octo/hello is:pr state:open",
    pull_requests: [pullRequestRow(7)],
    truncated: false,
  })
  expect(variable(apiCalls(installed)[0]!, "first")).toBe("30")
})

test.each([
  ["open", " state:open"],
  ["closed", " is:closed is:unmerged"],
  ["merged", " is:merged"],
  ["all", ""],
])("state %s", async (state, qualifier) => {
  const installed = useFake([searchRule()])
  await read({ method: "list", state })
  expect(searchedFor(installed)).toBe(`repo:octo/hello is:pr${qualifier}`)
})

test("filters follow the specified order and quote branches and labels", async () => {
  const installed = useFake([searchRule()])
  await read({
    method: "list",
    author: "@me",
    assignee: "octo_emu",
    base: "release/v1",
    head: "fix/crash",
    label: "good first issue",
    query: "  sort:updated-desc crash OR hang  ",
  })
  expect(searchedFor(installed)).toBe(
    'repo:octo/hello is:pr state:open author:@me assignee:octo_emu base:"release/v1" head:"fix/crash" label:"good first issue" sort:updated-desc crash OR hang',
  )
})

test("none assignee, blank filters and repository override", async () => {
  const installed = useFake([searchRule()])
  await read({
    method: "list",
    repo: "other/thing",
    assignee: "none",
    author: " ",
    base: " ",
    head: "",
    label: " ",
    query: " ",
  })
  expect(searchedFor(installed)).toBe("repo:other/thing is:pr state:open no:assignee")
})

test("maps list review, label, assignee and milestone fields", async () => {
  useFake([
    searchRule([
      rawRow(7, {
        state: "MERGED",
        isDraft: true,
        author: null,
        reviewDecision: "CHANGES_REQUESTED",
        labels: { nodes: [{ name: "bug" }] },
        assignees: { nodes: [{ login: "bob" }] },
        milestone: { title: "v1" },
      }),
    ]),
  ])
  expect((await read({ method: "list" })).pull_requests).toEqual([
    pullRequestRow(7, {
      state: "merged",
      draft: true,
      author: null,
      review_decision: "changes_requested",
      labels: ["bug"],
      assignees: ["bob"],
      milestone: "v1",
    }),
  ])
})

test("limit and truncated", async () => {
  const installed = useFake([{ match: SEARCH, stdout: searchPage([rawRow(7), rawRow(8)], "c1") }])
  const result = await read({ method: "list", limit: 2 })
  expect(result.pull_requests).toHaveLength(2)
  expect(result.truncated).toBe(true)
  expect(variable(apiCalls(installed)[0]!, "first")).toBe("2")
})

test.each(["repo:other/thing", "-repo:other/thing", "(repo:a/b OR repo:c/d)", "org:other", "user:alice"])(
  "refuses scoped query %s",
  async (query) => {
    const installed = useFake([])
    const error = await failure(read({ method: "list", query }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("repo:, org:, user:")
    expect(apiCalls(installed)).toHaveLength(0)
  },
)

test.each(["base", "head", "label"])("refuses unquotable %s", async (name) => {
  const installed = useFake([])
  for (const value of ['say "hi"', "back\\slash", "two\nlines", "carriage\rreturn"]) {
    const error = await failure(read({ method: "list", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(`${name} cannot contain a double quote, a backslash or a line break.`)
  }
  expect(apiCalls(installed)).toHaveLength(0)
})

test.each(["author", "assignee"])("validates %s logins", async (name) => {
  const installed = useFake([searchRule()])
  for (const value of ["bad name", "@you", "-alice", "a".repeat(40), "alice:x"]) {
    expect((await failure(read({ method: "list", [name]: value }))).code).toBe("invalid_argument")
  }
  expect(apiCalls(installed)).toHaveLength(0)
  for (const value of ["@me", "alice", "octo_emu", "a-b", "9lives"]) {
    await read({ method: "list", [name]: value })
    expect(searchedFor(installed)).toBe(`repo:octo/hello is:pr state:open ${name}:${value}`)
  }
})

test.each([
  ["pr", "7"],
  ["comments", 5],
])("list refuses %s", async (name, value) => {
  const error = await failure(read({ method: "list", [name as string]: value }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(`"${name}" is an argument of method "view", not "list"; leave it out.`)
})

test.each([0, 101, 1.5])("invalid limit %p", async (limit) => {
  expect((await failure(read({ method: "list", limit }))).code).toBe("invalid_argument")
})
