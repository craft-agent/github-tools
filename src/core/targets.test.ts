import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../testing/fake-gh"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { gqlErrors } from "../testing/gql"
import { apiCalls } from "../testing/issue-fixtures"
import {
  itemBoardRule,
  linkedBoardsRule,
  ownerBoardsRule,
  ownerTypeRule,
  rawBoard,
  viewerBoardsRule,
  viewerRule,
} from "../testing/project-fixtures"
import { isAbortError } from "./errors"
import { issueClose } from "./issues/close"
import { issueComment } from "./issues/comment"
import { issueCreate } from "./issues/create"
import { issueDevelop } from "./issues/develop"
import { issueEdit } from "./issues/edit"
import { issueRelate } from "./issues/relate"
import { issueReopen } from "./issues/reopen"
import { projectCreate } from "./projects/create"
import { projectFieldEnsure } from "./projects/field-ensure"
import { projectLink, projectUnlink } from "./projects/link"
import { projectViewEnsure } from "./projects/view-ensure"
import { writeTargets } from "./targets"
import type { ToolSpec } from "./tool"

const repos: TempRepo[] = []
let fake: FakeGh | undefined

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  fake?.restore()
  fake = undefined
})

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

/** A working tree whose `origin` is `octo/self`, or one without any. */
function tree(origin?: string): string {
  const repo = tempRepo(origin)
  repos.push(repo)
  return repo.dir
}

const WITH_ORIGIN = "https://github.com/Octo/Self.git"

const issueTargets: ToolSpec["targets"] = { issue: "issue", repo: "repo" }

const relateTargets: ToolSpec["targets"] = {
  issue: "issue",
  repo: "repo",
  parent: "issue",
  add_sub_issues: "issues",
  add_blocked_by: "issues",
}

/** A signal that is aborted already, so a git call (and nothing else) rejects. */
function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

describe("writeTargets", () => {
  test("a repo target is the lowercased repository", async () => {
    expect(await writeTargets({ targets: { repo: "repo" } }, { repo: "Octo/Hello" }, { cwd: tree() })).toEqual([
      "octo/hello",
    ])
  })

  test("a qualified issue names its own repository, not the working tree's", async () => {
    const cwd = tree(WITH_ORIGIN)
    expect(await writeTargets({ targets: issueTargets }, { issue: "other/repo#4", body: "x" }, { cwd })).toEqual([
      "other/repo",
    ])
    const url = "https://github.com/Other/Repo/issues/4"
    expect(await writeTargets({ targets: issueTargets }, { issue: url }, { cwd })).toEqual(["other/repo"])
  })

  test("a bare issue number means the repo argument, else the working tree's origin", async () => {
    const cwd = tree(WITH_ORIGIN)
    expect(await writeTargets({ targets: issueTargets }, { issue: "4" }, { cwd })).toEqual(["octo/self"])
    expect(await writeTargets({ targets: issueTargets }, { issue: "#4" }, { cwd })).toEqual(["octo/self"])
    expect(await writeTargets({ targets: issueTargets }, { issue: "4", repo: "x/y" }, { cwd })).toEqual(["x/y"])
  })

  test("a repo that disagrees with a qualified issue is listed beside it", async () => {
    const targets = await writeTargets({ targets: issueTargets }, { issue: "a/b#1", repo: "c/d" }, { cwd: tree() })
    expect(targets).toEqual(["a/b", "c/d"])
  })

  test("a bare number in a relation means the changed issue's repository", async () => {
    const cwd = tree(WITH_ORIGIN)
    const args = {
      issue: "a/b#1",
      parent: "2",
      add_sub_issues: ["3", "c/d#4"],
      add_blocked_by: ["https://github.com/e/f/issues/5"],
    }
    expect(await writeTargets({ targets: relateTargets }, args, { cwd })).toEqual(["a/b", "c/d", "e/f"])
  })

  test("a relation across two repositories asks for both", async () => {
    const cwd = tree(WITH_ORIGIN)
    expect(await writeTargets({ targets: relateTargets }, { issue: "1", parent: "other/repo#9" }, { cwd })).toEqual([
      "octo/self",
      "other/repo",
    ])
  })

  test("a branch repository beside the issue's asks for both", async () => {
    const targets: ToolSpec["targets"] = { ...issueTargets, branch_repo: "repo" }
    const cwd = tree(WITH_ORIGIN)
    expect(await writeTargets({ targets }, { issue: "3", branch_repo: "Fork/Self" }, { cwd })).toEqual([
      "fork/self",
      "octo/self",
    ])
  })

  test("a call without repo or other targets has the working tree's repository as its own", async () => {
    const targets: ToolSpec["targets"] = { repo: "repo", parent: "issue", blocked_by: "issues" }
    const cwd = tree(WITH_ORIGIN)
    expect(await writeTargets({ targets }, { title: "t" }, { cwd })).toEqual(["octo/self"])
    expect(await writeTargets({ targets }, { parent: "a/b#1", blocked_by: ["2", "c/d#3"] }, { cwd })).toEqual([
      "a/b",
      "c/d",
      "octo/self",
    ])
  })

  test("repeats collapse and the list is sorted", async () => {
    const args = { issue: "Z/z#1", repo: "z/Z", parent: "b/b#2", add_sub_issues: ["a/a#3", "B/B#4", "a/a#5"] }
    expect(await writeTargets({ targets: relateTargets }, args, { cwd: tree() })).toEqual(["a/a", "b/b", "z/z"])
  })

  test("blank values name nothing", async () => {
    const args = { issue: "a/b#1", repo: " ", parent: "", add_sub_issues: ["", "  "] }
    expect(await writeTargets({ targets: relateTargets }, args, { cwd: tree() })).toEqual(["a/b"])
  })

  describe("what cannot be told is *, last", () => {
    test.each([
      ["an invalid repo", { repo: "not a repo" }],
      ["a repo that is not a string", { repo: 3 }],
      ["an invalid issue", { issue: "nonsense", repo: "a/b" }],
      ["an issue that is a pull request URL", { issue: "https://github.com/c/d/pull/1", repo: "a/b" }],
      ["an issue that is not a string", { issue: 4, repo: "a/b" }],
      ["a list that is not an array", { issue: "a/b#1", add_sub_issues: "c/d#2" }],
      ["a list item that is not a string", { issue: "a/b#1", add_sub_issues: [7] }],
      ["a list item that is invalid", { issue: "a/b#1", add_sub_issues: ["c/d#2", "x"] }],
    ])("%s", async (_name, args) => {
      const targets = await writeTargets({ targets: relateTargets }, args, { cwd: tree() })
      expect(targets.at(-1)).toBe("*")
      expect(targets.filter((target) => target === "*")).toHaveLength(1)
    })

    test("an invalid repo keeps the other repositories", async () => {
      expect(await writeTargets({ targets: relateTargets }, { issue: "a/b#1", repo: "x" }, { cwd: tree() })).toEqual([
        "a/b",
        "*",
      ])
    })

    test("a bare number without an origin", async () => {
      const cwd = tree()
      expect(await writeTargets({ targets: relateTargets }, { issue: "1" }, { cwd })).toEqual(["*"])
      expect(await writeTargets({ targets: relateTargets }, { issue: "a/b#1", parent: "2" }, { cwd })).toEqual(["a/b"])
      expect(await writeTargets({ targets: relateTargets }, { issue: "1", repo: "a/b" }, { cwd })).toEqual(["a/b"])
    })

    test("arguments that are not an object", async () => {
      const cwd = tree()
      for (const args of [undefined, null, "x", 3, []]) {
        expect(await writeTargets({ targets: relateTargets }, args, { cwd })).toEqual(["*"])
      }
    })
  })

  describe("the working tree's origin is read lazily", () => {
    const signal = abortedSignal()
    const cwd = "/no/matter"

    test("not at all when every target is qualified", async () => {
      const args = {
        issue: "a/b#1",
        parent: "c/d#2",
        add_sub_issues: ["e/f#3"],
        add_blocked_by: ["https://github.com/g/h/issues/4"],
      }
      expect(await writeTargets({ targets: relateTargets }, args, { cwd, signal })).toEqual([
        "a/b",
        "c/d",
        "e/f",
        "g/h",
      ])
      expect(await writeTargets({ targets: issueTargets }, { issue: "a/b#1", repo: "c/d" }, { cwd, signal })).toEqual([
        "a/b",
        "c/d",
      ])
      expect(await writeTargets({ targets: { repo: "repo" } }, { repo: "a/b" }, { cwd, signal })).toEqual(["a/b"])
    })

    test.each([
      ["a bare issue number", { issue: "3" }],
      ["a bare number in a list and no issue", { add_sub_issues: ["3"] }],
      ["no repo at all", {}],
    ])("when %s needs it", async (_name, args) => {
      const error = await writeTargets({ targets: relateTargets }, args, { cwd, signal }).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(isAbortError(error)).toBe(true)
    })

    test("every bare reference means the same repository", async () => {
      const dir = tree(WITH_ORIGIN)
      const args = { issue: "1", parent: "2", add_sub_issues: ["3", "4"], add_blocked_by: ["5"] }
      expect(await writeTargets({ targets: relateTargets }, args, { cwd: dir })).toEqual(["octo/self"])
    })
  })

  describe("in the directory the tools are installed in", () => {
    test("a bare number and a missing repo are *, what is qualified still resolves", async () => {
      const ownDir = tree(WITH_ORIGIN)
      const ctx = { cwd: ownDir, ownDir }
      expect(await writeTargets({ targets: relateTargets }, { issue: "3" }, ctx)).toEqual(["*"])
      expect(await writeTargets({ targets: relateTargets }, {}, ctx)).toEqual(["*"])
      expect(await writeTargets({ targets: relateTargets }, { issue: "a/b#3", parent: "4" }, ctx)).toEqual(["a/b"])
      expect(await writeTargets({ targets: issueTargets }, { issue: "3", repo: "x/y" }, ctx)).toEqual(["x/y"])
    })

    test("another working tree is read as before", async () => {
      const ctx = { cwd: tree(WITH_ORIGIN), ownDir: tree("https://github.com/octo/own.git") }
      expect(await writeTargets({ targets: issueTargets }, { issue: "3" }, ctx)).toEqual(["octo/self"])
    })
  })

  describe("a spec without targets", () => {
    test("is its repo argument", async () => {
      expect(await writeTargets({}, { repo: "Octo/Hello" }, { cwd: tree() })).toEqual(["octo/hello"])
    })

    test("else the working tree's origin", async () => {
      expect(await writeTargets({}, {}, { cwd: tree(WITH_ORIGIN) })).toEqual(["octo/self"])
    })

    test("else *", async () => {
      const cwd = tree()
      expect(await writeTargets({}, {}, { cwd })).toEqual(["*"])
      expect(await writeTargets({}, { repo: "not a repo" }, { cwd })).toEqual(["*"])
      expect(await writeTargets({}, { repo: 3 }, { cwd })).toEqual(["*"])
    })

    test("ignores an issue argument", async () => {
      expect(await writeTargets({}, { issue: "a/b#1", repo: "c/d" }, { cwd: tree() })).toEqual(["c/d"])
    })
  })
})

describe("the issue write tools' targets", () => {
  test.each([
    [issueCreate.id, issueCreate, { repo: "repo", parent: "issue", blocked_by: "issues" }],
    [issueEdit.id, issueEdit, { issue: "issue", repo: "repo" }],
    [issueComment.id, issueComment, { issue: "issue", repo: "repo" }],
    [issueClose.id, issueClose, { issue: "issue", repo: "repo" }],
    [issueReopen.id, issueReopen, { issue: "issue", repo: "repo" }],
    [
      issueRelate.id,
      issueRelate,
      {
        issue: "issue",
        repo: "repo",
        parent: "issue",
        add_sub_issues: "issues",
        remove_sub_issues: "issues",
        add_blocked_by: "issues",
        remove_blocked_by: "issues",
        add_blocking: "issues",
        remove_blocking: "issues",
      },
    ],
    [issueDevelop.id, issueDevelop, { issue: "issue", repo: "repo", branch_repo: "repo" }],
  ] as const)("%s", (_id, spec, expected) => {
    expect(spec.targets).toEqual(expected)
  })

  test("closing as a duplicate writes nothing to the original's repository", async () => {
    const args = { issue: "a/b#1", reason: "duplicate", duplicate_of: "c/d#2" }
    expect(await writeTargets(issueClose, args, { cwd: tree() })).toEqual(["a/b"])
  })
})

describe("board and item targets", () => {
  const boardOnly: ToolSpec["targets"] = { project: "board" }
  const boardAndRepos: ToolSpec["targets"] = { project: "board", repo: "repo", link_repo: "repo" }
  const itemOnly: ToolSpec["targets"] = { item: "item" }

  describe("a named board needs no gh", () => {
    test("owner/N and a URL name the board, lowercased, and no own repository", async () => {
      const installed = useFake([])
      const ctx = { cwd: tree(WITH_ORIGIN) }
      expect(await writeTargets({ targets: boardOnly }, { project: "Octo/3" }, ctx)).toEqual(["octo/projects/3"])
      const url = "https://github.com/users/Alice/projects/4/views/1"
      expect(await writeTargets({ targets: boardOnly }, { project: url }, ctx)).toEqual(["alice/projects/4"])
      expect(apiCalls(installed)).toHaveLength(0)
    })

    test("a bare number takes owner, else the repo argument's owner, else the working tree's", async () => {
      const installed = useFake([])
      const ctx = { cwd: tree(WITH_ORIGIN) }
      expect(await writeTargets({ targets: boardOnly }, { project: "3", owner: "Acme" }, ctx)).toEqual([
        "acme/projects/3",
      ])
      expect(await writeTargets({ targets: boardOnly }, { project: "3", repo: "Other/Thing" }, ctx)).toEqual([
        "other/projects/3",
      ])
      expect(await writeTargets({ targets: boardOnly }, { project: "3" }, ctx)).toEqual(["octo/projects/3"])
      expect(apiCalls(installed)).toHaveLength(0)
    })

    test("the reference's own owner wins over owner", async () => {
      useFake([])
      expect(await writeTargets({ targets: boardOnly }, { project: "a/3", owner: "b" }, { cwd: tree() })).toEqual([
        "a/projects/3",
      ])
    })

    test("neither the origin nor gh is touched when the reference says it all", async () => {
      const installed = useFake([])
      const ctx = { cwd: "/no/matter", signal: abortedSignal() }
      expect(await writeTargets({ targets: boardOnly }, { project: "a/3" }, ctx)).toEqual(["a/projects/3"])
      expect(await writeTargets({ targets: boardOnly }, { project: "3", owner: "a" }, ctx)).toEqual(["a/projects/3"])
      expect(apiCalls(installed)).toHaveLength(0)
    })

    test("@me is the viewer's login, the one thing asked of gh", async () => {
      const installed = useFake([viewerRule("Alice")])
      const targets = await writeTargets({ targets: boardOnly }, { project: "2", owner: "@me" }, { cwd: tree() })
      expect(targets).toEqual(["alice/projects/2"])
      expect(apiCalls(installed)).toHaveLength(1)
    })

    test("a bare number without an origin, or in the install directory, is *", async () => {
      useFake([])
      expect(await writeTargets({ targets: boardOnly }, { project: "3" }, { cwd: tree() })).toEqual(["*"])
      const ownDir = tree(WITH_ORIGIN)
      expect(await writeTargets({ targets: boardOnly }, { project: "3" }, { cwd: ownDir, ownDir })).toEqual(["*"])
      expect(await writeTargets({ targets: boardOnly }, { project: "o/3" }, { cwd: ownDir, ownDir })).toEqual([
        "o/projects/3",
      ])
    })

    test.each([
      ["an empty project", { project: "" }],
      ["a blank project", { project: "  ", owner: "octo" }],
      ["a project that is not text", { project: 3, owner: "octo" }],
      ["an owner that is not a login", { project: "3", owner: "bad owner" }],
      ["an owner that is not text", { project: "3", owner: 1 }],
    ])("%s is *", async (_name, args) => {
      useFake([])
      expect(await writeTargets({ targets: boardOnly }, args, { cwd: tree(WITH_ORIGIN) })).toEqual(["*"])
    })
  })

  describe("a board the arguments do not name is looked up, by reads only", () => {
    test("the board linked to the working tree's repository", async () => {
      const installed = useFake([linkedBoardsRule("Octo", "Self", [rawBoard(4)])])
      expect(await writeTargets({ targets: boardOnly }, {}, { cwd: tree(WITH_ORIGIN) })).toEqual(["octo/projects/4"])
      expect(apiCalls(installed)).toHaveLength(1)
    })

    test("a project that is a title is looked up like none, with owner steering where", async () => {
      useFake([
        ownerTypeRule("acme", "Organization"),
        ownerBoardsRule("organization", "acme", [rawBoard(6, { title: "Plan" })]),
      ])
      const args = { project: "plan", owner: "acme" }
      expect(await writeTargets({ targets: boardOnly }, args, { cwd: tree() })).toEqual(["octo/projects/6"])
    })

    test("a title is looked up among the boards linked to the working tree's repository", async () => {
      const installed = useFake([linkedBoardsRule("Octo", "Self", [rawBoard(4), rawBoard(5, { title: "Plan" })])])
      expect(await writeTargets({ targets: boardOnly }, { project: " PLAN " }, { cwd: tree(WITH_ORIGIN) })).toEqual([
        "octo/projects/5",
      ])
      expect(apiCalls(installed)).toHaveLength(1)
    })

    test("a title that finds no board is *", async () => {
      useFake([linkedBoardsRule("Octo", "Self", []), ownerBoardsRule("organization", "Octo", []), viewerBoardsRule([])])
      expect(await writeTargets({ targets: boardOnly }, { project: "Plan" }, { cwd: tree(WITH_ORIGIN) })).toEqual(["*"])
    })

    test("the organization's, then the viewer's board, as the lookup goes", async () => {
      useFake([linkedBoardsRule("Octo", "Self", []), ownerBoardsRule("organization", "Octo", []), viewerBoardsRule([])])
      expect(await writeTargets({ targets: boardOnly }, {}, { cwd: tree(WITH_ORIGIN) })).toEqual(["*"])
    })

    test.each<[string, GhRule[]]>([
      [
        "no board anywhere",
        [linkedBoardsRule("Octo", "Self", []), ownerBoardsRule("organization", "Octo", []), viewerBoardsRule([])],
      ],
      ["several candidates", [linkedBoardsRule("Octo", "Self", [rawBoard(4), rawBoard(5)])]],
      [
        "a repository that cannot be read",
        [{ match: "projectsV2", stdout: gqlErrors([{ type: "NOT_FOUND", message: "x" }]) }],
      ],
      ["a gh that fails", [{ match: "projectsV2", stderr: "boom", code: 1 }]],
    ])("%s is *, and nothing throws", async (_name, rules) => {
      useFake(rules)
      expect(await writeTargets({ targets: boardOnly }, {}, { cwd: tree(WITH_ORIGIN) })).toEqual(["*"])
    })

    test("a working tree without an origin, and no owner, is *", async () => {
      useFake([viewerBoardsRule([rawBoard(4)])])
      expect(await writeTargets({ targets: boardOnly }, {}, { cwd: tree() })).toEqual(["*"])
    })

    test("a cancellation is not swallowed", async () => {
      useFake([viewerRule()])
      const cwd = tree(WITH_ORIGIN)
      const error = await writeTargets(
        { targets: boardOnly },
        { project: "2", owner: "@me" },
        { cwd, signal: abortedSignal() },
      ).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(isAbortError(error)).toBe(true)
    })
  })

  describe("a board names no own repository", () => {
    test("only the board when no repo argument is declared", async () => {
      useFake([])
      const args = { project: "a/1", repo: "x/y" }
      expect(await writeTargets({ targets: boardOnly }, args, { cwd: tree(WITH_ORIGIN) })).toEqual(["a/projects/1"])
    })

    test("a declared repo is the repository named, beside the board", async () => {
      useFake([])
      const args = { project: "a/1", repo: "Fork/Self" }
      expect(await writeTargets({ targets: boardAndRepos }, args, { cwd: tree(WITH_ORIGIN) })).toEqual([
        "a/projects/1",
        "fork/self",
      ])
    })

    test("a declared repo that is absent is the working tree's; other repo targets only when given", async () => {
      useFake([])
      const ctx = { cwd: tree(WITH_ORIGIN) }
      expect(await writeTargets({ targets: boardAndRepos }, { project: "a/1" }, ctx)).toEqual([
        "a/projects/1",
        "octo/self",
      ])
      const linked = { project: "a/1", link_repo: "Other/Thing" }
      expect(await writeTargets({ targets: boardAndRepos }, linked, ctx)).toEqual([
        "a/projects/1",
        "octo/self",
        "other/thing",
      ])
    })

    test("a declared repo that cannot be told is *, beside the board", async () => {
      useFake([])
      expect(await writeTargets({ targets: boardAndRepos }, { project: "a/1" }, { cwd: tree() })).toEqual([
        "a/projects/1",
        "*",
      ])
      expect(await writeTargets({ targets: boardAndRepos }, { project: "a/1", repo: "no" }, { cwd: tree() })).toEqual([
        "a/projects/1",
        "*",
      ])
      expect(await writeTargets({ targets: boardAndRepos }, { project: "a/1", repo: 3 }, { cwd: tree() })).toEqual([
        "*",
      ])
      expect(
        await writeTargets({ targets: boardAndRepos }, { project: "a/1", link_repo: "no" }, { cwd: tree(WITH_ORIGIN) }),
      ).toEqual(["a/projects/1", "octo/self", "*"])
    })

    test("a declared repo reads the origin even when the board is named", async () => {
      useFake([])
      const error = await writeTargets(
        { targets: boardAndRepos },
        { project: "a/1" },
        { cwd: "/no/matter", signal: abortedSignal() },
      ).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(isAbortError(error)).toBe(true)
    })

    test("a board spec's issue targets still mean the repository named", async () => {
      useFake([])
      const targets: ToolSpec["targets"] = { project: "board", item: "issue", repo: "repo" }
      const args = { project: "a/1", item: "c/d#2", repo: "x/y" }
      expect(await writeTargets({ targets }, args, { cwd: tree() })).toEqual(["a/projects/1", "c/d", "x/y"])
    })
  })

  describe("an item's board", () => {
    test("is read from GitHub for a node ID", async () => {
      const installed = useFake([
        itemBoardRule("PVTI_abc", rawBoard(3, { owner: { __typename: "Organization", login: "Octo" } })),
      ])
      expect(await writeTargets({ targets: itemOnly }, { item: "PVTI_abc" }, { cwd: tree() })).toEqual([
        "octo/projects/3",
      ])
      expect(apiCalls(installed)).toHaveLength(1)
    })

    test("an item that cannot be read is *", async () => {
      useFake([itemBoardRule("PVTI_abc", null)])
      expect(await writeTargets({ targets: itemOnly }, { item: "PVTI_abc" }, { cwd: tree() })).toEqual(["*"])
    })

    test("anything else is chosen by the board selectors", async () => {
      const installed = useFake([])
      const ctx = { cwd: tree(WITH_ORIGIN) }
      const targets: ToolSpec["targets"] = { item: "item" }
      expect(await writeTargets({ targets }, { item: "octo/hello#5", project: "9", owner: "acme" }, ctx)).toEqual([
        "acme/projects/9",
      ])
      expect(await writeTargets({ targets }, { item: "octo/hello#5", project: "acme/2" }, ctx)).toEqual([
        "acme/projects/2",
      ])
      expect(apiCalls(installed)).toHaveLength(0)
    })

    test("with no board selected it is the lookup", async () => {
      useFake([linkedBoardsRule("Octo", "Self", [rawBoard(4)])])
      expect(await writeTargets({ targets: itemOnly }, { item: "octo/hello#5" }, { cwd: tree(WITH_ORIGIN) })).toEqual([
        "octo/projects/4",
      ])
    })

    test("an item that is not text, absent or blank leaves the call with nothing named: *", async () => {
      useFake([])
      const ctx = { cwd: tree(WITH_ORIGIN) }
      for (const args of [{ item: 5 }, {}, { item: " " }]) {
        expect(await writeTargets({ targets: itemOnly }, args, ctx)).toEqual(["*"])
      }
    })

    test("the item's board and a named board are listed once each", async () => {
      useFake([itemBoardRule("PVTI_abc", rawBoard(3))])
      const targets: ToolSpec["targets"] = { project: "board", item: "item" }
      const args = { project: "octo/3", item: "PVTI_abc" }
      expect(await writeTargets({ targets }, args, { cwd: tree() })).toEqual(["octo/projects/3"])
    })
  })

  describe("an owner a board is created for", () => {
    const ownerOnly: ToolSpec["targets"] = { owner: "owner" }

    test("is owner/projects/new, lowercased, without gh", async () => {
      const installed = useFake([])
      expect(await writeTargets({ targets: ownerOnly }, { owner: "Octo" }, { cwd: tree(WITH_ORIGIN) })).toEqual([
        "octo/projects/new",
      ])
      expect(apiCalls(installed)).toHaveLength(0)
    })

    test("@me is the viewer's login, read from GitHub", async () => {
      useFake([viewerRule("Alice")])
      expect(await writeTargets({ targets: ownerOnly }, { owner: "@me" }, { cwd: tree() })).toEqual([
        "alice/projects/new",
      ])
    })

    test("absent, blank, invalid, not text or an unreadable viewer is *", async () => {
      useFake([])
      for (const args of [{}, { owner: " " }, { owner: "no way" }, { owner: 4 }, { owner: "@me" }]) {
        expect(await writeTargets({ targets: ownerOnly }, args, { cwd: tree() })).toEqual(["*"])
      }
    })

    test("names no own repository, and a repo target beside it is the one named", async () => {
      useFake([])
      const targets: ToolSpec["targets"] = { owner: "owner", link_repo: "repo" }
      const ctx = { cwd: tree(WITH_ORIGIN) }
      expect(await writeTargets({ targets }, { owner: "acme" }, ctx)).toEqual(["acme/projects/new"])
      expect(await writeTargets({ targets }, { owner: "acme", link_repo: "Acme/Widgets" }, ctx)).toEqual([
        "acme/projects/new",
        "acme/widgets",
      ])
      expect(await writeTargets({ targets }, { link_repo: "Acme/Widgets" }, ctx)).toEqual(["acme/widgets", "*"])
    })
  })

  describe("the board setup tools", () => {
    test.each([
      [projectCreate, { owner: "acme", link_repo: "acme/w" }, ["acme/projects/new", "acme/w"]],
      [projectLink, { project: "acme/2", repo: "acme/w" }, ["acme/projects/2", "acme/w"]],
      [projectLink, { project: "acme/2" }, ["acme/projects/2", "octo/self"]],
      [projectUnlink, { project: "acme/2", repo: "Acme/W" }, ["acme/projects/2", "acme/w"]],
      [projectFieldEnsure, { project: "acme/2", repo: "x/y" }, ["acme/projects/2"]],
      [projectViewEnsure, { project: "acme/2", repo: "x/y" }, ["acme/projects/2"]],
    ])("%#", async (spec, args, expected) => {
      useFake([])
      expect(await writeTargets(spec, args, { cwd: tree(WITH_ORIGIN) })).toEqual(expected)
    })
  })
})
