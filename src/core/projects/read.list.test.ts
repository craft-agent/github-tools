import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { gqlErrors } from "../../testing/gql"
import { apiCalls, failure } from "../../testing/issue-fixtures"
import {
  linkedBoardsRule,
  ownerBoardsRule,
  ownerTypeRule,
  rawBoard,
  rawUserBoard,
  viewerBoardsRule,
} from "../../testing/project-fixtures"
import { invoke } from "../tool"
import { projectRead } from "./read"

const ORIGIN = "https://github.com/octo/hello.git"

let repo: TempRepo
let fake: FakeGh | undefined

beforeEach(() => {
  repo = tempRepo(ORIGIN)
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

const read = (args: Record<string, unknown>) => invoke(projectRead, args, { cwd: repo.dir })

const row = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: "Roadmap",
  url: `https://github.com/orgs/octo/projects/${number}`,
  owner: "octo",
  closed: false,
  ...extra,
})

describe("list", () => {
  test("by default: the boards linked to the working tree's repository, open ones", async () => {
    const installed = useFake([
      linkedBoardsRule("octo", "hello", [rawBoard(1), rawBoard(2, { title: "Old", closed: true }), rawBoard(3)]),
    ])
    expect(await read({ method: "list" })).toEqual({ projects: [row(1), row(3)], truncated: false })
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("include_closed keeps the closed ones, and says they are", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(1), rawBoard(2, { title: "Old", closed: true })])])
    const result = await read({ method: "list", include_closed: true })
    expect(result.projects).toEqual([row(1), row(2, { title: "Old", closed: true })])
  })

  test("repo names another repository", async () => {
    const installed = useFake([linkedBoardsRule("other", "thing", [rawBoard(7)])])
    expect((await read({ method: "list", repo: "other/thing" })).projects).toEqual([row(7)])
    expect(apiCalls(installed)[0]!.join(" ")).toContain("owner=other -f name=thing")
  })

  test("owner is an organization's boards", async () => {
    useFake([ownerTypeRule("octo", "Organization"), ownerBoardsRule("organization", "octo", [rawBoard(1)])])
    expect((await read({ method: "list", owner: "octo" })).projects).toEqual([row(1)])
  })

  test("owner is a user's boards", async () => {
    useFake([ownerTypeRule("alice", "User"), ownerBoardsRule("user", "alice", [rawUserBoard(2)])])
    const result = await read({ method: "list", owner: "alice" })
    expect(result.projects).toEqual([row(2, { url: "https://github.com/users/alice/projects/2", owner: "alice" })])
  })

  test("@me is the viewer's boards", async () => {
    const installed = useFake([viewerBoardsRule([rawUserBoard(2)])])
    expect((await read({ method: "list", owner: "@me" })).projects?.map((project) => project.number)).toEqual([2])
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("is cut to limit, and says so", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(1), rawBoard(2), rawBoard(3)])])
    const result = await read({ method: "list", limit: 2 })
    expect(result.projects?.map((project) => project.number)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
  })

  test("is not truncated when limit fits the open boards exactly; closed ones do not count", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(1), rawBoard(2), rawBoard(3, { closed: true })])])
    expect((await read({ method: "list", limit: 2 })).truncated).toBe(false)
  })

  test("walks every page of an owner's boards", async () => {
    useFake([
      { ...ownerBoardsRule("organization", "octo", [rawBoard(1)], "c1"), times: 1 },
      ownerTypeRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(2)]),
    ])
    const result = await read({ method: "list", owner: "octo" })
    expect(result.projects?.map((project) => project.number)).toEqual([1, 2])
  })

  test("an owner that does not exist is not_found", async () => {
    useFake([
      {
        match: "repositoryOwner",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to a RepositoryOwner" }], {
          repositoryOwner: null,
        }),
      },
    ])
    expect((await failure(read({ method: "list", owner: "ghost" }))).code).toBe("not_found")
  })

  test("a repository that cannot be read is not_found, with no fall-through", async () => {
    const installed = useFake([
      {
        match: "projectsV2",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }], { repository: null }),
      },
    ])
    const error = await failure(read({ method: "list", repo: "other/thing" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("other/thing")
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("a working tree without a GitHub origin is invalid_argument", async () => {
    const bare = tempRepo()
    try {
      useFake([])
      expect((await failure(invoke(projectRead, { method: "list" }, { cwd: bare.dir }))).code).toBe("invalid_argument")
    } finally {
      bare.cleanup()
    }
  })

  test("owner and repo together are invalid_argument and nothing is asked of GitHub", async () => {
    const installed = useFake([])
    const error = await failure(read({ method: "list", owner: "octo", repo: "octo/hello" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('"owner" and "repo"')
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("an owner that is not a login is invalid_argument", async () => {
    const installed = useFake([])
    expect((await failure(read({ method: "list", owner: "bad owner" }))).code).toBe("invalid_argument")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each([0, 1.5, 2001])("limit %p is invalid_argument", async (limit) => {
    useFake([])
    expect((await failure(read({ method: "list", limit }))).code).toBe("invalid_argument")
  })

  test("limit above 100 is refused for list, which holds at most 100 boards per page", async () => {
    const installed = useFake([])
    const error = await failure(read({ method: "list", limit: 101 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("limit")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each([
    ["project", "octo/3"],
    ["status", "Todo"],
    ["content_type", "issue"],
    ["content_repo", "octo/hello"],
    ["search", "x"],
    ["include_archived", true],
  ])("the argument %s of another method is refused, by name", async (name, value) => {
    const installed = useFake([])
    const error = await failure(read({ method: "list", [name]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`"${name}"`)
    expect(apiCalls(installed)).toHaveLength(0)
  })
})
