import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { cancelCalls, cancelRule, rawRun, runViewRule } from "../../testing/runs-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { runCancel } from "./run-cancel"

const { use, run } = writeHarness(runCancel)

test("cancels an in-progress run and includes a hint when not yet completed or cancelled", async () => {
  const initial = rawRun(123, { status: "in_progress", conclusion: null })
  const updated = rawRun(123, { status: "in_progress", conclusion: null })
  const installed = use([repositoryRule(), runViewRule(initial, 1), cancelRule, runViewRule(updated, 1)])

  const result = await run({ run: "123" })
  expect(result).toEqual({
    repo: "octo/hello",
    run: 123,
    status: "in_progress",
    url: "https://github.com/octo/hello/actions/runs/123",
    foreign: false,
    hints: ["Cancelling takes a moment; read the run with github_run_read view to see it end."],
  })
  expect(cancelCalls(installed)).toEqual([["run", "cancel", "123", "--repo", "octo/hello"]])
})

test("omits hints when the run settled to completed or cancelled right away", async () => {
  const initial = rawRun(123, { status: "in_progress", conclusion: null })
  const updated = rawRun(123, { status: "completed", conclusion: "cancelled" })
  use([repositoryRule(), runViewRule(initial, 1), cancelRule, runViewRule(updated, 1)])

  const result = await run({ run: "123" })
  expect(result.status).toBe("completed")
  expect(result.hints).toBeUndefined()
})

test("refuses a completed run without writing", async () => {
  const initial = rawRun(123, { status: "completed", conclusion: "success" })
  const installed = use([repositoryRule(), runViewRule(initial, 1), cancelRule])

  const error = await failure(run({ run: "123" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain("Workflow run 123 of octo/hello ended success; nothing to cancel.")
  expect(cancelCalls(installed)).toEqual([])
})

test("confirmation declined throws declined and writes nothing", async () => {
  const initial = rawRun(123, {
    workflowName: "Deploy",
    status: "in_progress",
    conclusion: null,
    event: "push",
    headBranch: "main",
  })
  const installed = use([repositoryRule(), runViewRule(initial, 1), cancelRule])

  const requests: ConfirmRequest[] = []
  const result = invoke(
    runCancel,
    { run: "123" },
    {
      cwd: process.cwd(),
      confirm: async (req) => {
        requests.push(req)
        return false
      },
    },
  )

  const err = await failure(result)
  expect(err.code).toBe("declined")
  expect(requests).toEqual([
    {
      tool: "github_run_cancel",
      message:
        'Cancel "Deploy" run 123 (in_progress, push on main) in octo/hello? Its jobs stop where they are, and a deploy may be left half done.',
    },
  ])
  expect(cancelCalls(installed)).toEqual([])
})

test("reports foreign true for a repository the viewer does not own", async () => {
  const initial = rawRun(123, { status: "in_progress", conclusion: null })
  const updated = rawRun(123, { status: "completed", conclusion: "cancelled" })
  const installed = use([
    repositoryRule({ repo: "other/repo", viewer: "me" }),
    runViewRule(initial, 1),
    cancelRule,
    runViewRule(updated, 1),
  ])

  const result = await run({ run: "123", repo: "other/repo" })
  expect(result.repo).toBe("other/repo")
  expect(result.foreign).toBe(true)
  expect(cancelCalls(installed)).toEqual([["run", "cancel", "123", "--repo", "other/repo"]])
})

test("accepts a run URL and uses its repository", async () => {
  const initial = rawRun(789, { status: "in_progress", conclusion: null })
  const updated = rawRun(789, { status: "completed", conclusion: "cancelled" })
  const installed = use([
    repositoryRule({ repo: "other/repo", viewer: "me" }),
    runViewRule(initial, 1),
    cancelRule,
    runViewRule(updated, 1),
  ])

  const url = "https://github.com/other/repo/actions/runs/789"
  const result = await run({ run: url })
  expect(result.repo).toBe("other/repo")
  expect(result.run).toBe(789)
  expect(cancelCalls(installed)).toEqual([["run", "cancel", "789", "--repo", "other/repo"]])
})

test("a run that ends between the read and the cancel is stale", async () => {
  const initial = rawRun(123, { status: "in_progress", conclusion: null })
  use([
    repositoryRule(),
    runViewRule(initial, 1),
    {
      match: "^run cancel",
      stderr:
        "failed to cancel run: HTTP 409: Cannot cancel a workflow run that is completed. (https://api.github.com/repos/o/r/actions/runs/123/cancel)",
      code: 1,
    },
  ])

  const error = await failure(run({ run: "123" }))
  expect(error.code).toBe("stale")
})
