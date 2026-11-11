import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  headSha,
  mergePollRule,
  mergePutRule,
  mergePuts,
  mergeReply,
  mergeSha,
  mergeStateRule,
  mergingRules,
  methodsRule,
  stackedAt,
} from "../../testing/merge-fixtures"
import { apiPaths, rawFullStack, stackFailureRule, stackRule } from "../../testing/stack-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prMerge } from "./merge"

const { use, run } = writeHarness(prMerge)

const base = [repositoryRule(), methodsRule("squash")]
const MERGED_BELOW = { state: "closed", merged_at: "2026-11-02T00:00:00Z" }
const STACK_READ = "repos/octo/hello/stacks/1"

describe("a layer above the bottom", () => {
  test("is refused, listing the open layers below it, unless they are asked for", async () => {
    const installed = use([
      ...base,
      mergeStateRule(5, stackedAt(1, 2)),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5),
    ])
    const error = await failure(run({ pr: "5" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "octo/hello#5 is layer 2 of stack #1; merging it also merges the open layers below it: #4. Pass with_lower_layers: true to merge them together, or merge #4 first.",
    )
    expect(mergePuts(installed)).toEqual([])
  })

  test("lists every open layer below, and names the lowest to merge first", async () => {
    use([...base, mergeStateRule(5, stackedAt(1, 3)), stackRule(1, rawFullStack(1, [3, 4, 5]))])
    const error = await failure(run({ pr: "5" }))
    expect(error.message).toContain("layer 3 of stack #1")
    expect(error.message).toContain("below it: #3, #4. Pass")
    expect(error.message).toContain("merge #3 first.")
  })

  test("with_lower_layers merges them all in one request: the result lists both, bottom to top", async () => {
    const installed = use([
      ...base,
      ...mergingRules(5, stackedAt(1, 2)),
      ...mergingRules(4, stackedAt(1, 1)),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5, mergeReply("merged")),
    ])
    expect(await run({ pr: "5", with_lower_layers: true, subject: "Top layer", body: "Only for #5." })).toEqual({
      repo: "octo/hello",
      pr: 5,
      method: "squash",
      status: "merged",
      merged: [
        { number: 4, state: "merged", merge_commit: mergeSha(4) },
        { number: 5, state: "merged", merge_commit: mergeSha(5) },
      ],
      request: null,
      branches: [],
      changed: true,
      notes: [],
      foreign: false,
      errors: {},
    })
    expect(mergePuts(installed)).toEqual([
      {
        path: "repos/octo/hello/pulls/5/merge-async",
        body: { merge_method: "squash", sha: headSha(5), commit_title: "Top layer", commit_message: "Only for #5." },
      },
    ])
  })

  test("a lower layer that is a draft is refused by name, and nothing is sent", async () => {
    const installed = use([
      ...base,
      mergeStateRule(5, stackedAt(1, 2)),
      mergeStateRule(4, { ...stackedAt(1, 1), isDraft: true }),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5),
    ])
    const error = await failure(run({ pr: "5", with_lower_layers: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("octo/hello#4 (a layer below #5) is a draft; mark it ready with github_pr_ready first.")
    expect(mergePuts(installed)).toEqual([])
  })

  test("a lower layer in conflict is refused by name, and nothing is sent", async () => {
    const installed = use([
      ...base,
      mergeStateRule(5, stackedAt(1, 2)),
      mergeStateRule(4, { ...stackedAt(1, 1), mergeable: "CONFLICTING" }),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5),
    ])
    const error = await failure(run({ pr: "5", with_lower_layers: true }))
    expect(error.message).toContain("octo/hello#4 (a layer below #5) has conflicts with main")
    expect(mergePuts(installed)).toEqual([])
  })

  test("a lower layer that merged already is no layer to take along: it merges alone", async () => {
    const installed = use([
      ...base,
      ...mergingRules(5, stackedAt(1, 2)),
      stackRule(1, rawFullStack(1, [4, 5], { 4: MERGED_BELOW })),
      mergePutRule(5, mergeReply("merged")),
    ])
    const result = await run({ pr: "5" })
    expect(result.merged).toEqual([{ number: 5, state: "merged", merge_commit: mergeSha(5) }])
    expect(mergePuts(installed)).toHaveLength(1)
  })

  test("with_lower_layers is fine when there is nothing below to take", async () => {
    use([
      ...base,
      ...mergingRules(5, stackedAt(1, 2)),
      stackRule(1, rawFullStack(1, [4, 5], { 4: MERGED_BELOW })),
      mergePutRule(5, mergeReply("merged")),
    ])
    expect((await run({ pr: "5", with_lower_layers: true })).merged).toHaveLength(1)
  })

  test("a stack that cannot be read stops the call before anything is sent", async () => {
    const installed = use([
      ...base,
      mergeStateRule(5, stackedAt(1, 2)),
      stackFailureRule("stacks/1$", "Not Found (HTTP 404)"),
      mergePutRule(5),
    ])
    expect((await failure(run({ pr: "5", with_lower_layers: true }))).code).toBe("not_found")
    expect(mergePuts(installed)).toEqual([])
  })
})

describe("the bottom layer", () => {
  test("merges alone: the stack is not read, and the layers above are not touched", async () => {
    const installed = use([
      ...base,
      ...mergingRules(4, stackedAt(1, 1)),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(4, mergeReply("merged")),
    ])
    const result = await run({ pr: "4" })
    expect(result.merged).toEqual([{ number: 4, state: "merged", merge_commit: mergeSha(4) }])
    expect(mergePuts(installed).map((put) => put.path)).toEqual(["repos/octo/hello/pulls/4/merge-async"])
    expect(apiPaths(installed)).not.toContain(STACK_READ)
  })

  test("with_lower_layers changes nothing for it", async () => {
    const installed = use([...base, ...mergingRules(4, stackedAt(1, 1)), mergePutRule(4, mergeReply("merged"))])
    expect(await run({ pr: "4", with_lower_layers: true })).toMatchObject({ status: "merged" })
    expect(mergePuts(installed)).toHaveLength(1)
  })
})

describe("a stacked merge that fails", () => {
  const failed = mergeReply("failed", { message: "Merge conflict in #5." })

  test("with a lower layer merged it is reported under errors.merge, and the merged layer is not lost", async () => {
    use([
      ...base,
      ...mergingRules(5, stackedAt(1, 2), {}),
      ...mergingRules(4, stackedAt(1, 1)),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5),
      mergePollRule(5, failed),
    ])
    expect(await run({ pr: "5", with_lower_layers: true })).toMatchObject({
      status: "failed",
      merged: [
        { number: 4, state: "merged", merge_commit: mergeSha(4) },
        { number: 5, state: "open", merge_commit: null },
      ],
      errors: { merge: "Merge conflict in #5." },
    })
  })

  test("with nothing merged it is an upstream_error", async () => {
    use([
      ...base,
      mergeStateRule(5, stackedAt(1, 2)),
      mergeStateRule(4, stackedAt(1, 1)),
      stackRule(1, rawFullStack(1, [4, 5])),
      mergePutRule(5),
      mergePollRule(5, failed),
    ])
    const error = await failure(run({ pr: "5", with_lower_layers: true }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("GitHub could not merge octo/hello#5: Merge conflict in #5.")
  })
})
