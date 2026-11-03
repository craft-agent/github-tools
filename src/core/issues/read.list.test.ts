import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors, gqlReply } from "../../testing/gql"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  SEARCH,
  apiCalls,
  failure,
  rawRow,
  searchPage,
  searchRule,
  searchedFor,
  variable,
} from "../../testing/issue-fixtures"
import { resetIssueTypeCache } from "../github/repository"
import { invoke } from "../tool"
import { issueRead } from "./read"

const ORIGIN = "https://github.com/octo/hello.git"
const ISSUE_TYPES = "issueTypes\\(first"

let repo: TempRepo
let fake: FakeGh | undefined

beforeEach(() => {
  repo = tempRepo(ORIGIN)
  resetIssueTypeCache()
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

const read = (args: Record<string, unknown>) => invoke(issueRead, args, { cwd: repo.dir })

describe("list: building the search", () => {
  test("by default: this repository's open issues, 30 at most", async () => {
    const installed = useFake([searchRule([rawRow(1)])])
    const result = await read({ method: "list" })
    expect(searchedFor(installed)).toBe("repo:octo/hello is:issue state:open")
    expect(result.query).toBe("repo:octo/hello is:issue state:open")
    expect(result.repo).toBe("octo/hello")
    expect(result.issues?.map((issue) => issue.number)).toEqual([1])
    expect(result.truncated).toBe(false)
    expect(variable(apiCalls(installed)[0]!, "first")).toBe("30")
  })

  test("the repo argument names another repository, and limit sets the page size", async () => {
    const installed = useFake([searchRule()])
    await read({ method: "list", repo: "other/thing", limit: 5 })
    expect(searchedFor(installed)).toBe("repo:other/thing is:issue state:open")
    expect(variable(apiCalls(installed)[0]!, "first")).toBe("5")
  })

  test("says when more issues matched than the limit", async () => {
    useFake([{ match: SEARCH, stdout: searchPage([rawRow(1), rawRow(2)], "c1") }])
    const result = await read({ method: "list", limit: 2 })
    expect(result.issues).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  test("a search GitHub refuses fails with GitHub's text", async () => {
    useFake([{ match: SEARCH, stdout: gqlErrors([{ message: "The listed users cannot be searched" }]) }])
    const error = await failure(read({ method: "list", assignee: "ghost" }))
    expect(error.message).toContain("cannot be searched")
  })

  test.each([
    ["open", " state:open"],
    ["closed", " state:closed"],
    ["all", ""],
  ])("state %s", async (state, qualifier) => {
    const installed = useFake([searchRule()])
    await read({ method: "list", state })
    expect(searchedFor(installed)).toBe(`repo:octo/hello is:issue${qualifier}`)
  })

  test("milestone, label, assignee and query follow in that order, quoted", async () => {
    const installed = useFake([searchRule()])
    await read({
      method: "list",
      milestone: "Sprint 4",
      label: "good first issue",
      assignee: "alice",
      query: "  sort:updated-desc crash  ",
    })
    expect(searchedFor(installed)).toBe(
      'repo:octo/hello is:issue state:open milestone:"Sprint 4" label:"good first issue" assignee:alice sort:updated-desc crash',
    )
  })

  test('milestone "none" and assignee "none" become no: qualifiers', async () => {
    const installed = useFake([searchRule()])
    await read({ method: "list", milestone: "none", assignee: "none" })
    expect(searchedFor(installed)).toBe("repo:octo/hello is:issue state:open no:milestone no:assignee")
  })

  test.each(["@me", "alice", "octo_emu", "a-b", "9lives"])("assignee %s is passed as it is", async (assignee) => {
    const installed = useFake([searchRule()])
    await read({ method: "list", assignee })
    expect(searchedFor(installed)).toBe(`repo:octo/hello is:issue state:open assignee:${assignee}`)
  })

  test.each(["bad name", "-alice", "al ice", "@you", "a".repeat(40), "alice:x", "al\nice"])(
    "assignee %p is invalid_argument and nothing is searched",
    async (assignee) => {
      const installed = useFake([searchRule()])
      const error = await failure(read({ method: "list", assignee }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("assignee")
      expect(apiCalls(installed)).toHaveLength(0)
    },
  )

  test("blank filters count as not given", async () => {
    const installed = useFake([searchRule()])
    await read({ method: "list", milestone: " ", label: "", assignee: " ", query: "  " })
    expect(searchedFor(installed)).toBe("repo:octo/hello is:issue state:open")
  })

  test.each([
    ["milestone", 'say "hi"'],
    ["milestone", "back\\slash"],
    ["label", "two\nlines"],
    ["label", "carriage\rreturn"],
    ["kind", 'bu"g'],
  ])("%s %p cannot be quoted: invalid_argument, nothing is asked of GitHub", async (name, value) => {
    const installed = useFake([searchRule()])
    const error = await failure(read({ method: "list", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(name)
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each([
    "repo:other/thing",
    "bug -repo:other/thing",
    "bug org:other",
    "user:alice bug",
    "-user:alice",
    "(repo:a/b OR repo:c/d)",
    "bug\nORG:other",
  ])("query %p names another repository or owner: invalid_argument", async (query) => {
    const installed = useFake([searchRule()])
    const error = await failure(read({ method: "list", query }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("repo:, org:, user:")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("runs the plain issue search, which keeps OR inside the repository", async () => {
    const installed = useFake([searchRule()])
    await read({ method: "list", query: "crash OR hang" })
    const call = apiCalls(installed)[0]!.join(" ")
    expect(call).toContain("search(type:ISSUE,")
    expect(searchedFor(installed)).toBe("repo:octo/hello is:issue state:open crash OR hang")
  })

  test.each(["sort:updated-desc crash", "-label:wontfix", "in:title crash", "reporter:alice"])(
    "query %p is passed on",
    async (query) => {
      const installed = useFake([searchRule()])
      await read({ method: "list", query })
      expect(searchedFor(installed)).toBe(`repo:octo/hello is:issue state:open ${query}`)
    },
  )

  describe("kind", () => {
    const organizationTypes = (nodes: { name: string; isEnabled: boolean }[]): GhRule => ({
      match: ISSUE_TYPES,
      stdout: gqlReply({ repositoryOwner: { __typename: "Organization", issueTypes: { nodes } } }),
    })
    const userOwner: GhRule = { match: ISSUE_TYPES, stdout: gqlReply({ repositoryOwner: { __typename: "User" } }) }

    test("is the Issue Type of that name when the organization defines it, from one read of the owner", async () => {
      const installed = useFake([
        organizationTypes([
          { name: "Bug", isEnabled: true },
          { name: "Epic", isEnabled: false },
        ]),
        searchRule(),
      ])
      await read({ method: "list", kind: "bug" })
      expect(searchedFor(installed)).toBe('repo:octo/hello is:issue state:open type:"Bug"')
      expect(apiCalls(installed)).toHaveLength(2)
    })

    test("is the type: label when the organization defines no such type, or it is disabled", async () => {
      const installed = useFake([organizationTypes([{ name: "Epic", isEnabled: false }]), searchRule()])
      await read({ method: "list", kind: "Epic" })
      expect(searchedFor(installed)).toBe('repo:octo/hello is:issue state:open label:"type:epic"')
    })

    test("is the type: label for a user's repository, which has no Issue Types", async () => {
      const installed = useFake([userOwner, searchRule()])
      await read({ method: "list", kind: "Bug" })
      expect(searchedFor(installed)).toBe('repo:octo/hello is:issue state:open label:"type:bug"')
    })

    test("is the type: label when GitHub refuses the viewer the organization's Issue Types", async () => {
      const installed = useFake([
        {
          match: ISSUE_TYPES,
          stdout: gqlErrors([{ type: "FORBIDDEN", message: "no permission to retrieve issueType" }]),
        },
        searchRule(),
      ])
      await read({ method: "list", kind: "bug" })
      expect(searchedFor(installed)).toBe('repo:octo/hello is:issue state:open label:"type:bug"')
    })

    test("a rate-limited Issue Types read fails the list rather than matching by label", async () => {
      const installed = useFake([
        { match: ISSUE_TYPES, stdout: gqlErrors([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]) },
        searchRule(),
      ])
      expect((await failure(read({ method: "list", kind: "bug" }))).code).toBe("rate_limited")
      expect(apiCalls(installed).some((args) => args.join(" ").includes("search(type:ISSUE"))).toBe(false)
    })

    test("comes before the other filters", async () => {
      const installed = useFake([userOwner, searchRule()])
      await read({ method: "list", kind: "bug", label: "ui", query: "crash" })
      expect(searchedFor(installed)).toBe('repo:octo/hello is:issue state:open label:"type:bug" label:"ui" crash')
    })
  })
})

describe("list: arguments", () => {
  test.each([
    ["issue", "12"],
    ["comments", 5],
  ])("the view argument %s is refused, by name", async (name, value) => {
    const installed = useFake([searchRule()])
    const error = await failure(read({ method: "list", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`"${name}"`)
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each([0, 101, 1.5])("limit %p is invalid_argument", async (limit) => {
    useFake([searchRule()])
    const error = await failure(read({ method: "list", limit }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("limit")
  })

  test("an unknown state or argument is invalid_argument", async () => {
    useFake([searchRule()])
    for (const args of [
      { method: "list", state: "merged" },
      { method: "list", sort: "asc" },
    ]) {
      expect((await failure(read(args))).code).toBe("invalid_argument")
    }
  })

  test("a repository that cannot be told is invalid_argument", async () => {
    const bare = tempRepo()
    try {
      useFake([searchRule()])
      const error = await failure(invoke(issueRead, { method: "list" }, { cwd: bare.dir }))
      expect(error.code).toBe("invalid_argument")
    } finally {
      bare.cleanup()
    }
  })
})
