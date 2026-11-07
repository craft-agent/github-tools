import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { rawJob, rawRun, rerunCalls, rerunRule, runViewRule } from "../../testing/runs-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { runRerun } from "./run-rerun"

const { use, run } = writeHarness(runRerun)

test("re-runs failed jobs by default, returning the attempt it starts", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const result = await run({ run: "123" })
  expect(result).toEqual({
    repo: "octo/hello",
    run: 123,
    attempt: 2,
    url: "https://github.com/octo/hello/actions/runs/123",
    foreign: false,
  })
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "123", "--repo", "octo/hello", "--failed"]])
})

test("re-runs every job when failed_only is false", async () => {
  const initial = rawRun(123, { conclusion: "success", jobs: [rawJob(10, "build")] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const result = await run({ run: "123", failed_only: false })
  expect(result.attempt).toBe(2)
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "123", "--repo", "octo/hello"]])
})

test("re-runs a specific job by id", async () => {
  const job = rawJob(42, "deploy", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const result = await run({ run: "123", job: 42 })
  expect(result.attempt).toBe(2)
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "123", "--repo", "octo/hello", "--job", "42"]])
})

test("passes --debug when debug is true", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  await run({ run: "123", debug: true })
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "123", "--repo", "octo/hello", "--failed", "--debug"]])
})

test("reports foreign true for a repository the viewer does not own", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule({ repo: "other/repo", viewer: "me" }), runViewRule(initial, 1), rerunRule])

  const result = await run({ run: "123", repo: "other/repo" })
  expect(result.repo).toBe("other/repo")
  expect(result.foreign).toBe(true)
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "123", "--repo", "other/repo", "--failed"]])
})

test("accepts a run URL and uses its repository", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(456, { conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule({ repo: "other/repo", viewer: "me" }), runViewRule(initial, 1), rerunRule])

  const url = "https://github.com/other/repo/actions/runs/456"
  const result = await run({ run: url })
  expect(result.repo).toBe("other/repo")
  expect(result.run).toBe(456)
  expect(rerunCalls(installed)).toEqual([["run", "rerun", "456", "--repo", "other/repo", "--failed"]])
})

test("refuses a run that is not completed without writing", async () => {
  const initial = rawRun(123, { status: "in_progress", conclusion: null })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const error = await failure(run({ run: "123" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain("Workflow run 123 of octo/hello is still in_progress")
  expect(rerunCalls(installed)).toEqual([])
})

test("refuses when nothing failed and failed_only is default or true", async () => {
  const initial = rawRun(123, { status: "completed", conclusion: "success" })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const error = await failure(run({ run: "123" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain("Workflow run 123 of octo/hello ended success; nothing failed")
  expect(rerunCalls(installed)).toEqual([])
})

test("refuses when both job and failed_only are given", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { status: "completed", conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const error = await failure(run({ run: "123", job: 10, failed_only: true }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("Pass job or failed_only, not both.")
  expect(rerunCalls(installed)).toEqual([])
})

test("refuses an unknown job id with not_found without writing", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { status: "completed", conclusion: "failure", jobs: [job] })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const error = await failure(run({ run: "123", job: 999 }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe("Job 999 was not found in workflow run 123 of octo/hello.")
  expect(rerunCalls(installed)).toEqual([])
})

test("confirmation declined throws declined and writes nothing", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, {
    workflowName: "Build",
    conclusion: "failure",
    event: "push",
    headBranch: "main",
    headSha: "1234567890abcdef1234567890abcdef",
    jobs: [job],
  })
  const installed = use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const requests: ConfirmRequest[] = []
  const result = invoke(
    runRerun,
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
      tool: "github_run_rerun",
      message:
        'Re-run the failed jobs of "Build" run 123 (failure, push on main at 1234567890ab) in octo/hello? Their steps run again, a deploy or a publish included.',
    },
  ])
  expect(rerunCalls(installed)).toEqual([])
})

test.each([
  [
    {},
    'Re-run the failed jobs of "CI" run 123 (failure, push on main at abc123000000) in octo/hello? Their steps run again, a deploy or a publish included.',
  ],
  [
    { failed_only: false },
    'Re-run every job of "CI" run 123 (failure, push on main at abc123000000) in octo/hello? Their steps run again, a deploy or a publish included.',
  ],
  [
    { job: 10 },
    'Re-run job "test" of "CI" run 123 (failure, push on main at abc123000000) in octo/hello? Its steps run again, a deploy or a publish included.',
  ],
])("confirmation message variants for %p", async (extraArgs, expectedMessage) => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, {
    conclusion: "failure",
    headSha: "abc1230000000000",
    jobs: [job],
  })
  use([repositoryRule(), runViewRule(initial, 1), rerunRule])

  const requests: ConfirmRequest[] = []
  await invoke(
    runRerun,
    { run: "123", ...extraArgs },
    {
      cwd: process.cwd(),
      confirm: async (req) => {
        requests.push(req)
        return true
      },
    },
  )

  expect(requests).toEqual([{ tool: "github_run_rerun", message: expectedMessage }])
})

test("maps GitHub HTTP 422 refusal to invalid_argument", async () => {
  const job = rawJob(10, "test", { status: "completed", conclusion: "failure" })
  const initial = rawRun(123, { conclusion: "failure", jobs: [job] })
  use([
    repositoryRule(),
    runViewRule(initial, 1),
    {
      match: "^run rerun",
      stderr:
        "failed to rerun: HTTP 422: This workflow run cannot be retried (https://api.github.com/repos/o/r/actions/runs/123/rerun-failed-jobs)",
      code: 1,
    },
  ])

  const error = await failure(run({ run: "123" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain("This workflow run cannot be retried")
})
