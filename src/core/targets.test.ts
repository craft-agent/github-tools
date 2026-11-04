import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { isAbortError } from "./errors"
import { issueClose } from "./issues/close"
import { issueComment } from "./issues/comment"
import { issueCreate } from "./issues/create"
import { issueDevelop } from "./issues/develop"
import { issueEdit } from "./issues/edit"
import { issueRelate } from "./issues/relate"
import { issueReopen } from "./issues/reopen"
import { writeTargets } from "./targets"
import type { ToolSpec } from "./tool"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

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
