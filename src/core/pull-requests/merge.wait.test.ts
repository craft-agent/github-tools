import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  mergePollFailureRule,
  mergePollRule,
  mergePutRule,
  mergePuts,
  mergeReply,
  mergeSha,
  mergeStateRule,
  mergingRules,
  methodsRule,
  pendingReply,
} from "../../testing/merge-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prMerge } from "./merge"
import { followMerge } from "./merge-request"

const { use, run } = writeHarness(prMerge)

const REPO = { owner: "octo", name: "hello", full: "octo/hello" }
const FAST = { intervalMs: 50, timeoutMs: 1500 }

const base = [repositoryRule(), methodsRule("squash")]
const polls = (installed: ReturnType<typeof use>) =>
  sent(installed).filter((args) => args.some((arg) => /\/merge-async\/[\w-]+$/.test(arg)))

describe("the wait", () => {
  test("pending, then merged on the first read", async () => {
    const installed = use([...base, ...mergingRules(7), mergePutRule(7), mergePollRule(7, mergeReply("merged"))])
    expect(await run({ pr: "7" })).toMatchObject({
      status: "merged",
      request: "uuid-1",
      changed: true,
      merged: [{ number: 7, state: "merged", merge_commit: mergeSha(7) }],
      notes: [],
    })
    expect(polls(installed)).toHaveLength(1)
  })

  test("pending twice before merged: the request is read again after the interval", async () => {
    const installed = use([
      ...base,
      ...mergingRules(7),
      mergePutRule(7),
      mergePollRule(7, pendingReply(), 1),
      mergePollRule(7, mergeReply("merged")),
    ])
    expect(await run({ pr: "7" })).toMatchObject({ status: "merged" })
    expect(polls(installed)).toHaveLength(2)
  })

  test("a merge GitHub finishes at once is not polled", async () => {
    const installed = use([...base, ...mergingRules(7), mergePutRule(7, mergeReply("merged"))])
    expect(await run({ pr: "7" })).toMatchObject({ status: "merged", request: null })
    expect(polls(installed)).toEqual([])
  })

  test("enqueued: in the merge queue, nothing merged yet, with a note", async () => {
    const installed = use([...base, mergeStateRule(7), mergePutRule(7, mergeReply("enqueued"))])
    expect(await run({ pr: "7" })).toMatchObject({
      status: "enqueued",
      merged: [{ number: 7, state: "open", merge_commit: null }],
      notes: ["In the merge queue; it merges when the queue reaches it."],
      changed: true,
    })
    expect(polls(installed)).toEqual([])
  })

  test("enqueued with delete_branch keeps the branch and says so", async () => {
    const installed = use([...base, mergeStateRule(7), mergePutRule(7, mergeReply("enqueued"))])
    const result = await run({ pr: "7", delete_branch: true })
    expect(result).toMatchObject({ status: "enqueued", branches: [] })
    expect(result.notes).toContain(
      "The head branch of a pull request that has not merged yet was not deleted; delete it once it lands.",
    )
    expect(installed.calls().some((call) => call.includes("DELETE"))).toBe(false)
  })

  test("enqueued by the poll is the same", async () => {
    use([...base, mergeStateRule(7), mergePutRule(7), mergePollRule(7, mergeReply("enqueued"))])
    expect(await run({ pr: "7" })).toMatchObject({ status: "enqueued", request: "uuid-1" })
  })
})

describe("a request that ends without an answer", () => {
  test("a poll that is gone (404) leaves the pull request states to decide: merged", async () => {
    use([...base, ...mergingRules(7), mergePutRule(7), mergePollFailureRule(7, "Not Found (HTTP 404)")])
    const result = await run({ pr: "7" })
    expect(result).toMatchObject({ status: "merged", errors: {}, notes: [] })
    expect(result.merged).toEqual([{ number: 7, state: "merged", merge_commit: mergeSha(7) }])
  })

  test("a poll that is gone (404) with the pull request still open is pending, with a note", async () => {
    use([...base, mergeStateRule(7), mergePutRule(7), mergePollFailureRule(7, "Not Found (HTTP 404)")])
    expect(await run({ pr: "7" })).toMatchObject({
      status: "pending",
      request: "uuid-1",
      merged: [{ number: 7, state: "open", merge_commit: null }],
      notes: ["GitHub is still merging; github_pr_read view shows when it lands."],
      errors: {},
    })
  })

  test("a poll that fails otherwise is kept under errors.poll, and the call still reports", async () => {
    use([...base, ...mergingRules(7), mergePutRule(7), mergePollFailureRule(7, "Bad Gateway (HTTP 502)")])
    const result = await run({ pr: "7" })
    expect(result).toMatchObject({ status: "merged", changed: true })
    expect(result.errors.poll).toContain("502")
  })

  test("a read-back that fails keeps what was asked under errors.read", async () => {
    use([
      ...base,
      mergeStateRule(7, {}, 1),
      { match: "mergeCommit\\{oid\\}", stderr: "boom", code: 1 },
      mergePutRule(7, mergeReply("merged")),
    ])
    const result = await run({ pr: "7" })
    expect(result.status).toBe("merged")
    expect(result.errors.read).toContain("boom")
  })

  test("the wait is bounded: a request still pending at the deadline stays pending", async () => {
    const installed = use([...base, mergePollRule(7, pendingReply())])
    const outcome = await followMerge(
      REPO,
      7,
      { status: "pending", message: null, uuid: "uuid-1" },
      { cwd: process.cwd() },
      FAST,
    )
    expect(outcome).toMatchObject({ status: "pending", uuid: "uuid-1", poll_error: null })
    expect(polls(installed).length).toBeGreaterThan(1)
  })
})

describe("a merge GitHub could not make", () => {
  const failed = mergeReply("failed", { message: "Required status check is expected." })

  test("with nothing merged it is an upstream_error carrying GitHub's message", async () => {
    use([...base, mergeStateRule(7), mergePutRule(7), mergePollRule(7, failed)])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("GitHub could not merge octo/hello#7: Required status check is expected.")
  })

  test("a refusal in the request itself is thrown as it is, and no poll follows", async () => {
    const installed = use([
      ...base,
      mergeStateRule(7),
      { match: "-X PUT", stderr: "gh: Pull Request is not mergeable (HTTP 405)", code: 1 },
    ])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("not mergeable")
    expect(mergePuts(installed)).toHaveLength(1)
    expect(polls(installed)).toEqual([])
  })
})
