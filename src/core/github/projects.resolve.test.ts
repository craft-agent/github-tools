import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { gqlErrors } from "../../testing/gql"
import { apiCalls, failure } from "../../testing/issue-fixtures"
import {
  board,
  itemBoardRule,
  linkedBoardsRule,
  namedBoardRule,
  ownerBoardsRule,
  ownerTypeRule,
  rawBoard,
  rawUserBoard,
  viewerBoardsRule,
  viewerRule,
} from "../../testing/project-fixtures"
import { readBoardItemBoard, resolveBoard } from "./projects"

const ORIGIN = "https://github.com/octo/hello.git"
const NOT_FOUND = { type: "NOT_FOUND", message: "Could not resolve to a ProjectV2 with the number 9." }

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

const resolve = (selector: Parameters<typeof resolveBoard>[0]) => resolveBoard(selector, { cwd: repo.dir })

describe("resolveBoard: a board named by a reference", () => {
  test("a number with owner is looked up under that owner's type", async () => {
    const installed = useFake([
      ownerTypeRule("octo", "Organization"),
      namedBoardRule("organization", "octo", 3, rawBoard(3)),
    ])
    expect(await resolve({ project: "3", owner: "octo" })).toEqual({
      project: board(3),
      route: "named",
      considered: [{ route: "named", outcome: 'octo/projects/3 "Roadmap"' }],
    })
    expect(apiCalls(installed)).toHaveLength(2)
  })

  test("a user's board is read from the user, and reports it", async () => {
    useFake([ownerTypeRule("alice", "User"), namedBoardRule("user", "alice", 2, rawUserBoard(2))])
    const result = await resolve({ project: "alice/2" })
    expect(result.project).toEqual(
      board(2, { owner: "alice", owner_type: "user", url: "https://github.com/users/alice/projects/2" }),
    )
  })

  test("owner/N and a URL name their own owner, in a directory with no origin", async () => {
    const bare = tempRepo()
    try {
      useFake([ownerTypeRule("octo", "Organization"), namedBoardRule("organization", "octo", 3, rawBoard(3))])
      for (const project of ["octo/3", "https://github.com/orgs/octo/projects/3/views/1?x=1"]) {
        const result = await resolveBoard({ project, owner: "ignored" }, { cwd: bare.dir })
        expect(result.project.number).toBe(3)
      }
    } finally {
      bare.cleanup()
    }
  })

  test("a bare number takes the owner of the repo argument, else of the working tree's repository", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      ownerTypeRule("other", "Organization"),
      namedBoardRule("organization", "octo", 3, rawBoard(3)),
      namedBoardRule(
        "organization",
        "other",
        3,
        rawBoard(3, { owner: { __typename: "Organization", login: "other" } }),
      ),
    ])
    expect((await resolve({ project: "3" })).project.owner).toBe("octo")
    expect((await resolve({ project: "3", repo: "other/thing" })).project.owner).toBe("other")
  })

  test("a closed board is used as it is, and read-only is reported, not filtered", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      namedBoardRule("organization", "octo", 3, rawBoard(3, { closed: true, viewerCanUpdate: false })),
    ])
    const result = await resolve({ project: "3", owner: "octo" })
    expect(result.project).toEqual(board(3, { closed: true, can_update: false }))
  })

  test("@me is the viewer: no owner lookup", async () => {
    const installed = useFake([viewerRule(), namedBoardRule("user", "alice", 2, rawUserBoard(2))])
    const result = await resolve({ project: "2", owner: "@me" })
    expect(result.project.owner).toBe("alice")
    expect(apiCalls(installed).some((args) => args.join(" ").includes("repositoryOwner"))).toBe(false)
  })

  test("a board that does not exist is not_found and names it", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      { match: "projectV2\\(number", stdout: gqlErrors([NOT_FOUND], { organization: { projectV2: null } }) },
    ])
    const error = await failure(resolve({ project: "octo/9" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/projects/9")
  })

  test("a board reply without the board is not_found", async () => {
    useFake([ownerTypeRule("octo", "Organization"), namedBoardRule("organization", "octo", 9, null)])
    expect((await failure(resolve({ project: "octo/9" }))).code).toBe("not_found")
  })

  test("an owner that is neither user nor organization is not_found", async () => {
    useFake([ownerTypeRule("ghost", null)])
    const error = await failure(resolve({ project: "ghost/1" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("ghost")
  })

  test("a token without the project scope is forbidden, with the command that fixes it", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      {
        match: "projectV2\\(number",
        stdout: gqlErrors([
          { type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" },
        ]),
      },
    ])
    const error = await failure(resolve({ project: "octo/3" }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("gh auth refresh -s project")
  })

  test.each([
    ["an owner that is not a login", { project: "3", owner: "bad owner" }],
    ["digits that cannot be a board number", { project: "0" }],
    ["an empty project", { project: "" }],
    ["a blank project", { project: "  " }],
  ])("%s is invalid_argument and nothing is asked of GitHub", async (_name, selector) => {
    const installed = useFake([])
    expect((await failure(resolve(selector))).code).toBe("invalid_argument")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("a bare number with no owner in the tools' install directory fails like a bare issue number", async () => {
    const installed = useFake([])
    const error = await failure(resolveBoard({ project: "3" }, { cwd: repo.dir, ownDir: repo.dir }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("where these tools are installed")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("a bare number with an owner, or a qualified one, still resolves in the install directory", async () => {
    useFake([ownerTypeRule("octo", "Organization"), namedBoardRule("organization", "octo", 3, rawBoard(3))])
    const ctx = { cwd: repo.dir, ownDir: repo.dir }
    expect((await resolveBoard({ project: "3", owner: "octo" }, ctx)).project.number).toBe(3)
    expect((await resolveBoard({ project: "octo/3" }, ctx)).project.number).toBe(3)
  })
})

describe("resolveBoard: by title, in the owner's boards", () => {
  const owned = [
    rawBoard(1, { title: "Roadmap Archive" }),
    rawBoard(2, { title: "  roadmap " }),
    rawBoard(3, { title: "Roadmap", closed: true }),
    rawBoard(4, { title: "Plan" }),
  ]

  test("finds the open board of that whole title, case-insensitive, by default Roadmap", async () => {
    useFake([ownerTypeRule("octo", "Organization"), ownerBoardsRule("organization", "octo", owned)])
    expect(await resolve({ owner: "octo" })).toEqual({
      project: board(2, { title: "  roadmap " }),
      route: "owner",
      considered: [{ route: "owner", outcome: 'octo/projects/2 "  roadmap "' }],
    })
  })

  test("a project that is no reference is the title", async () => {
    useFake([ownerTypeRule("octo", "Organization"), ownerBoardsRule("organization", "octo", owned)])
    expect((await resolve({ owner: "octo", project: "PLAN" })).project.number).toBe(4)
    expect((await resolve({ owner: "octo", project: "  plan  " })).project.number).toBe(4)
  })

  test("a title that looks like a repository reference is still a title", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(7, { title: "octo/hello#3" })]),
    ])
    expect((await resolve({ owner: "octo", project: "octo/hello#3" })).project.number).toBe(7)
  })

  test("@me searches the viewer's boards, with no owner lookup", async () => {
    const installed = useFake([viewerBoardsRule([rawUserBoard(8)])])
    const result = await resolve({ owner: "@me" })
    expect(result.route).toBe("owner")
    expect(result.project.number).toBe(8)
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("only that owner's boards are looked at: no linked or viewer route", async () => {
    const installed = useFake([
      ownerTypeRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", []),
      viewerBoardsRule([rawUserBoard(9)]),
    ])
    const error = await failure(resolve({ owner: "octo" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('No open board titled "Roadmap"')
    expect(error.message).toContain("owner:")
    expect(apiCalls(installed)).toHaveLength(2)
  })

  test("several boards of the title are invalid_argument, listing the candidates", async () => {
    useFake([
      ownerTypeRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(5), rawBoard(6, { title: "ROADMAP" })]),
    ])
    const error = await failure(resolve({ owner: "octo" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('octo/projects/5 "Roadmap"')
    expect(error.message).toContain('octo/projects/6 "ROADMAP"')
  })

  test("walks every page of the owner's boards", async () => {
    const installed = useFake([
      { ...ownerBoardsRule("organization", "octo", [rawBoard(1, { title: "Other" })], "c1"), times: 1 },
      ownerTypeRule("octo", "Organization"),
      ownerBoardsRule("organization", "octo", [rawBoard(2)]),
    ])
    expect((await resolve({ owner: "octo" })).project.number).toBe(2)
    expect(apiCalls(installed).filter((args) => args.includes("after=c1"))).toHaveLength(1)
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
    expect((await failure(resolve({ owner: "ghost" }))).code).toBe("not_found")
  })
})

describe("resolveBoard: by title, without an owner", () => {
  test("a board linked to the working tree's repository comes first, and stops the search", async () => {
    const installed = useFake([linkedBoardsRule("octo", "hello", [rawBoard(4)])])
    expect(await resolve({})).toEqual({
      project: board(4),
      route: "linked",
      considered: [{ route: "linked", outcome: 'octo/projects/4 "Roadmap"' }],
    })
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("a project that is a title is looked up the same way", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(4, { title: "Plan" }), rawBoard(5)])])
    const result = await resolve({ project: "plan" })
    expect(result.route).toBe("linked")
    expect(result.project.number).toBe(4)
  })

  test("the repo argument replaces the working tree's repository", async () => {
    useFake([
      linkedBoardsRule("other", "thing", [rawBoard(4, { owner: { __typename: "Organization", login: "other" } })]),
    ])
    const result = await resolve({ repo: "other/thing", project: "roadmap" })
    expect(result.route).toBe("linked")
    expect(result.project.owner).toBe("other")
  })

  test("then the organization that owns the repository, where the owner type is already known", async () => {
    const installed = useFake([
      linkedBoardsRule("octo", "hello", [rawBoard(1, { title: "Plan" })]),
      ownerBoardsRule("organization", "octo", [rawBoard(5)]),
    ])
    const result = await resolve({})
    expect(result.route).toBe("organization")
    expect(result.project.number).toBe(5)
    expect(result.considered).toEqual([
      { route: "linked", outcome: 'no open board titled "Roadmap"' },
      { route: "organization", outcome: 'octo/projects/5 "Roadmap"' },
    ])
    expect(apiCalls(installed)).toHaveLength(2)
  })

  test("then the viewer's boards; a user's repository skips the organization route, and says so", async () => {
    useFake([linkedBoardsRule("alice", "hello", [], "User"), viewerBoardsRule([rawUserBoard(8, { title: "ROADMAP" })])])
    const result = await resolve({ repo: "alice/hello" })
    expect(result.route).toBe("viewer")
    expect(result.project.number).toBe(8)
    expect(result.considered.map((entry) => entry.route)).toEqual(["linked", "organization", "viewer"])
    expect(result.considered[1]!.outcome).toContain("owned by a user")
  })

  test("a board the viewer cannot update is found all the same, and reported", async () => {
    useFake([linkedBoardsRule("octo", "hello", [rawBoard(4, { viewerCanUpdate: false })])])
    expect((await resolve({})).project.can_update).toBe(false)
  })

  test("a closed board is never found by title", async () => {
    useFake([
      linkedBoardsRule("octo", "hello", [rawBoard(4, { closed: true })]),
      ownerBoardsRule("organization", "octo", []),
      viewerBoardsRule([]),
    ])
    expect((await failure(resolve({}))).code).toBe("not_found")
  })

  test("several on one route stop the call before the next route", async () => {
    const installed = useFake([
      linkedBoardsRule("octo", "hello", [rawBoard(4), rawBoard(7)]),
      ownerBoardsRule("organization", "octo", [rawBoard(5)]),
    ])
    const error = await failure(resolve({}))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("linked")
    expect(error.message).toContain('octo/projects/4 "Roadmap"')
    expect(error.message).toContain('octo/projects/7 "Roadmap"')
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("a title found nowhere is not_found, naming every route tried", async () => {
    useFake([linkedBoardsRule("octo", "hello", []), ownerBoardsRule("organization", "octo", []), viewerBoardsRule([])])
    const error = await failure(resolve({ project: "Plan" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('No open board titled "Plan"')
    for (const route of ["linked:", "organization:", "viewer:"]) expect(error.message).toContain(route)
  })

  test("a repository that does not exist fails; no other route is tried", async () => {
    const installed = useFake([
      {
        match: "owner\\{__typename login\\} projectsV2",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }], { repository: null }),
      },
      viewerBoardsRule([rawUserBoard(8)]),
    ])
    const error = await failure(resolve({ repo: "other/thing" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("other/thing")
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("a repository that cannot be read for another reason fails the same way", async () => {
    const installed = useFake([
      {
        match: "owner\\{__typename login\\} projectsV2",
        stdout: gqlErrors([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]),
      },
      viewerBoardsRule([rawUserBoard(8)]),
    ])
    expect((await failure(resolve({}))).code).toBe("rate_limited")
    expect(apiCalls(installed)).toHaveLength(1)
  })

  test("a working tree without a GitHub origin fails and asks for repo or owner", async () => {
    const bare = tempRepo()
    try {
      const installed = useFake([viewerBoardsRule([rawUserBoard(8)])])
      const error = await failure(resolveBoard({}, { cwd: bare.dir }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("repo")
      expect(apiCalls(installed)).toHaveLength(0)
    } finally {
      bare.cleanup()
    }
  })

  test("in the tools' install directory, with no repo or owner, it fails like a bare number", async () => {
    const installed = useFake([viewerBoardsRule([rawUserBoard(8)])])
    const error = await failure(resolveBoard({}, { cwd: repo.dir, ownDir: repo.dir }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("where these tools are installed")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("in the install directory, repo or owner is enough", async () => {
    useFake([linkedBoardsRule("other", "thing", [rawBoard(4)]), viewerBoardsRule([rawUserBoard(8)])])
    const ctx = { cwd: repo.dir, ownDir: repo.dir }
    expect((await resolveBoard({ repo: "other/thing" }, ctx)).route).toBe("linked")
    expect((await resolveBoard({ owner: "@me" }, ctx)).route).toBe("owner")
  })
})

describe("readBoardItemBoard", () => {
  test("is the board an item sits on", async () => {
    useFake([itemBoardRule("PVTI_1", rawBoard(3))])
    expect(await readBoardItemBoard("PVTI_1", { cwd: repo.dir })).toEqual(board(3))
  })

  test.each([
    ["a node that is not an item", { match: "on ProjectV2Item", stdout: JSON.stringify({ data: { node: {} } }) }],
    ["a node that does not exist", itemBoardRule("PVTI_1", null)],
    [
      "an id GitHub cannot resolve",
      {
        match: "on ProjectV2Item",
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to a node" }], { node: null }),
      },
    ],
  ] as const)("%s is not_found", async (_name, rule) => {
    useFake([rule])
    const error = await failure(readBoardItemBoard("PVTI_1", { cwd: repo.dir }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("PVTI_1")
  })
})
