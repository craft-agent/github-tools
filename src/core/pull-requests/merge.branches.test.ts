import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import {
  basedOnRule,
  branchDeleteRule,
  branchDeletes,
  branchRule,
  defaultBranchRule,
  headSha,
  mergePutRule,
  mergeReply,
  mergeStateRule,
  mergedState,
  mergingRules,
  methodsRule,
  stackedAt,
} from "../../testing/merge-fixtures"
import { rawFullStack, stackRule } from "../../testing/stack-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prMerge } from "./merge"

const { use, run } = writeHarness(prMerge)

const MERGES_AT_ONCE: GhRule[] = [repositoryRule(), methodsRule("squash"), mergePutRule(7, mergeReply("merged"))]
const ready = (extra = {}): GhRule[] => [...MERGES_AT_ONCE, ...mergingRules(7, extra), defaultBranchRule()]
const DELETE_7 = "repos/octo/hello/git/refs/heads/feature-7"
const branchCalls = (installed: ReturnType<typeof use>) =>
  sent(installed).filter((args) => args[0] === "pr" || args.some((arg) => arg.includes("/branches/")))

describe("delete_branch", () => {
  test("deletes the head branch of the merged pull request", async () => {
    const installed = use([
      ...ready(),
      basedOnRule(),
      branchRule("feature-7", headSha(7)),
      branchDeleteRule("feature-7"),
    ])
    const result = await run({ pr: "7", delete_branch: true })
    expect(result.branches).toEqual([{ name: "feature-7", result: "deleted", reason: null }])
    expect(branchDeletes(installed)).toEqual([DELETE_7])
    const asked = sent(installed).find((args) => args[0] === "pr")!
    expect(asked).toEqual([
      "pr",
      "list",
      "--repo",
      "octo/hello",
      "--base",
      "feature-7",
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ])
  })

  test("without it no branch is read or deleted", async () => {
    const installed = use([
      ...ready(),
      basedOnRule(),
      branchRule("feature-7", headSha(7)),
      branchDeleteRule("feature-7"),
    ])
    expect((await run({ pr: "7" })).branches).toEqual([])
    expect(branchCalls(installed)).toEqual([])
    expect(branchDeletes(installed)).toEqual([])
  })

  test("the encoded name keeps its slashes", async () => {
    const installed = use([
      ...ready({ headRefName: "feat/a b" }),
      basedOnRule(),
      branchRule("feat/a%20b", headSha(7)),
      branchDeleteRule("feat/a%20b"),
    ])
    expect((await run({ pr: "7", delete_branch: true })).branches[0]).toMatchObject({
      name: "feat/a b",
      result: "deleted",
    })
    expect(branchDeletes(installed)).toEqual(["repos/octo/hello/git/refs/heads/feat/a%20b"])
  })

  test("the default branch is kept", async () => {
    const installed = use([
      ...ready({ headRefName: "main" }),
      basedOnRule(),
      branchRule("main", headSha(7)),
      branchDeleteRule("main"),
    ])
    expect((await run({ pr: "7", delete_branch: true })).branches).toEqual([
      { name: "main", result: "kept", reason: "it is the default branch" },
    ])
    expect(branchDeletes(installed)).toEqual([])
  })

  test("a branch another open pull request is based on is kept", async () => {
    const installed = use([
      ...ready(),
      basedOnRule(9),
      branchRule("feature-7", headSha(7)),
      branchDeleteRule("feature-7"),
    ])
    expect((await run({ pr: "7", delete_branch: true })).branches).toEqual([
      { name: "feature-7", result: "kept", reason: "#9 is based on it" },
    ])
    expect(branchDeletes(installed)).toEqual([])
  })

  test("a branch with new commits since the merge is kept", async () => {
    const installed = use([
      ...ready(),
      basedOnRule(),
      branchRule("feature-7", headSha(8)),
      branchDeleteRule("feature-7"),
    ])
    expect((await run({ pr: "7", delete_branch: true })).branches).toEqual([
      { name: "feature-7", result: "kept", reason: "it has new commits" },
    ])
    expect(branchDeletes(installed)).toEqual([])
  })

  test("a branch in a fork is kept, and the repository's branch of that name is not read", async () => {
    const installed = use([...ready({ isCrossRepository: true }), basedOnRule(), branchRule("feature-7", headSha(7))])
    expect((await run({ pr: "7", delete_branch: true })).branches).toEqual([
      { name: "feature-7", result: "kept", reason: "it is in a fork" },
    ])
    expect(branchCalls(installed)).toEqual([])
  })

  test("a branch that is gone is reported so", async () => {
    const installed = use([...ready(), basedOnRule(), branchRule("feature-7", null), branchDeleteRule("feature-7")])
    expect((await run({ pr: "7", delete_branch: true })).branches).toEqual([
      { name: "feature-7", result: "already_gone", reason: null },
    ])
    expect(branchDeletes(installed)).toEqual([])
  })

  test("a delete that fails is not_deleted with the error, and the merge still succeeds", async () => {
    use([
      ...ready(),
      basedOnRule(),
      branchRule("feature-7", headSha(7)),
      branchDeleteRule("feature-7", "Forbidden (HTTP 403)"),
    ])
    const result = await run({ pr: "7", delete_branch: true })
    expect(result).toMatchObject({ status: "merged", changed: true, errors: {} })
    expect(result.branches).toHaveLength(1)
    expect(result.branches[0]).toMatchObject({ name: "feature-7", result: "not_deleted" })
    expect(result.branches[0]!.reason).toContain("403")
  })

  test("a lookup that fails is not_deleted too", async () => {
    use([...ready(), { match: "^pr list", stderr: "gh: Bad Gateway (HTTP 502)", code: 1 }])
    const result = await run({ pr: "7", delete_branch: true })
    expect(result.branches[0]).toMatchObject({ result: "not_deleted" })
    expect(result.status).toBe("merged")
  })

  test("a pull request in the merge queue has no branch to delete yet", async () => {
    const installed = use([
      repositoryRule(),
      methodsRule("squash"),
      mergeStateRule(7),
      mergePutRule(7, mergeReply("enqueued")),
      defaultBranchRule(),
    ])
    expect(await run({ pr: "7", delete_branch: true })).toMatchObject({ status: "enqueued", branches: [] })
    expect(branchCalls(installed)).toEqual([])
  })

  test("a pull request merged already has its branch left alone", async () => {
    const installed = use([repositoryRule(), mergeStateRule(7, mergedState(7)), basedOnRule(), defaultBranchRule()])
    expect(await run({ pr: "7", delete_branch: true })).toMatchObject({ changed: false, branches: [] })
    expect(branchCalls(installed)).toEqual([])
  })
})

describe("delete_branch on a stacked merge", () => {
  const stacked = (...rules: GhRule[]): GhRule[] => [
    repositoryRule(),
    methodsRule("squash"),
    ...mergingRules(5, stackedAt(1, 2)),
    ...mergingRules(4, stackedAt(1, 1)),
    stackRule(1, rawFullStack(1, [4, 5])),
    mergePutRule(5, mergeReply("merged")),
    defaultBranchRule(),
    basedOnRule(),
    ...rules,
  ]

  test("each merged layer's branch goes, bottom to top", async () => {
    const installed = use(
      stacked(
        branchRule("feature-4", headSha(4)),
        branchRule("feature-5", headSha(5)),
        branchDeleteRule("feature-4"),
        branchDeleteRule("feature-5"),
      ),
    )
    const result = await run({ pr: "5", with_lower_layers: true, delete_branch: true })
    expect(result.branches).toEqual([
      { name: "feature-4", result: "deleted", reason: null },
      { name: "feature-5", result: "deleted", reason: null },
    ])
    expect(branchDeletes(installed)).toEqual([
      "repos/octo/hello/git/refs/heads/feature-4",
      "repos/octo/hello/git/refs/heads/feature-5",
    ])
  })

  test("a layer whose delete fails does not stop the next one", async () => {
    const installed = use(
      stacked(
        branchRule("feature-4", headSha(4)),
        branchRule("feature-5", headSha(5)),
        branchDeleteRule("feature-4", "Forbidden (HTTP 403)"),
        branchDeleteRule("feature-5"),
      ),
    )
    const result = await run({ pr: "5", with_lower_layers: true, delete_branch: true })
    expect(result.branches.map((branch) => [branch.name, branch.result])).toEqual([
      ["feature-4", "not_deleted"],
      ["feature-5", "deleted"],
    ])
    expect(branchDeletes(installed)).toEqual([
      "repos/octo/hello/git/refs/heads/feature-4",
      "repos/octo/hello/git/refs/heads/feature-5",
    ])
  })
})
