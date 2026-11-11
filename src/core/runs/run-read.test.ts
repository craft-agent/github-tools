import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { logLine } from "../../testing/pull-request-fixtures"
import { expectedRun, rawJob, rawRun, runListRule, runViewRule } from "../../testing/runs-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { runRead } from "./run-read"

const { use: install, run } = writeHarness(runRead)

/** The fake `gh`, whose calls leave out the one-time `--version` check. */
function use(rules: GhRule[]) {
  const installed = install(rules)
  return { calls: () => installed.calls().filter((args) => args[0] !== "--version") }
}

const FIELDS =
  "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName"
const logRule = (job: number, text: string) => ({ match: `^run view --job ${job} `, stdout: text })
const logCalls = (calls: string[][]) => calls.filter((args) => args[2] === "--job")
const failingRun = (extra: Record<string, unknown> = {}) =>
  rawRun(1, {
    conclusion: "failure",
    jobs: [
      rawJob(101, "build", {
        conclusion: "failure",
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Run tests", conclusion: "failure" },
          { name: "Deploy", conclusion: "timed_out" },
          { name: "Cleanup", conclusion: "skipped" },
        ],
      }),
      rawJob(102, "lint"),
    ],
    ...extra,
  })

describe("list", () => {
  test("lists runs with the default limit and no filters", async () => {
    const installed = use([
      runListRule([rawRun(2), rawRun(1, { conclusion: "", status: "in_progress", startedAt: null })]),
    ])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      runs: [expectedRun(2), expectedRun(1, { conclusion: null, status: "in_progress", started_at: null })],
      truncated: false,
    })
    expect(installed.calls()).toEqual([["run", "list", "--repo", "octo/hello", "--limit", "21", "--json", FIELDS]])
  })

  test("passes every filter, and --all with a workflow", async () => {
    const installed = use([runListRule([])])
    await run({
      method: "list",
      branch: "main",
      workflow: "ci.yml",
      status: "failure",
      event: "push",
      commit: "abc123",
      limit: 5,
    })
    expect(installed.calls()[0]).toEqual([
      ...["run", "list", "--repo", "octo/hello", "--limit", "6", "--json", FIELDS],
      ...["--branch", "main", "--workflow", "ci.yml", "--all", "--status", "failure", "--event", "push"],
      ...["--commit", "abc123"],
    ])
  })

  test("truncated when more than limit came back", async () => {
    use([runListRule([rawRun(3), rawRun(2), rawRun(1)])])
    const result = await run({ method: "list", limit: 2 })
    expect(result.runs?.map((row) => row.id)).toEqual([3, 2])
    expect(result.truncated).toBe(true)
  })

  test("falls back to the run name when the workflow has none", async () => {
    use([runListRule([rawRun(1, { workflowName: "", workflowDatabaseId: undefined })])])
    const [row] = (await run({ method: "list" })).runs!
    expect(row).toMatchObject({ workflow: "CI", workflow_id: null })
  })

  test.each([{ status: "bogus" }, { limit: 0 }, { limit: 1001 }])("invalid %j", async (extra) => {
    expect((await failure(run({ method: "list", ...extra }))).code).toBe("invalid_argument")
  })
})

describe("view", () => {
  test("reads a run with its jobs and failed steps", async () => {
    const installed = use([runViewRule(failingRun()), logRule(101, logLine("##[error]boom"))])
    const result = await run({ method: "view", run: "1", wait: 0 })
    expect(result.run).toEqual({
      ...expectedRun(1, { conclusion: "failure" }),
      jobs: [
        {
          id: 101,
          name: "build",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-11-01T00:00:06Z",
          completed_at: "2026-11-01T00:04:00Z",
          url: "https://github.com/octo/hello/actions/runs/1/job/101",
          failed_steps: ["Run tests", "Deploy"],
        },
        expect.objectContaining({ id: 102, conclusion: "success", failed_steps: [] }),
      ],
    })
    expect(result.failed_logs).toEqual([expect.objectContaining({ name: "build", job: 101, errors: ["boom"] })])
    expect(result.waited).toEqual({ seconds: expect.any(Number), polls: 1, ended_by: "not_waiting" })
    expect(result.hints).toEqual([])
    expect(installed.calls()[0]).toEqual(["run", "view", "1", "--repo", "octo/hello", "--json", `${FIELDS},jobs`])
    expect(logCalls(installed.calls())).toEqual([
      ["run", "view", "--job", "101", "--log-failed", "--repo", "octo/hello"],
    ])
  })

  test("a job that has not started has no start time, and attempt is passed on", async () => {
    const installed = use([
      runViewRule(
        rawRun(1, {
          jobs: [rawJob(5, "build", { startedAt: "0001-01-01T00:00:00Z", completedAt: "0001-01-01T00:00:00Z" })],
        }),
      ),
    ])
    const result = await run({ method: "view", run: "1", attempt: 2, wait: 0 })
    expect(result.run?.jobs[0]).toMatchObject({ started_at: null, completed_at: null })
    expect(installed.calls()[0]!.slice(-2)).toEqual(["--attempt", "2"])
  })

  test("log_lines 0 reads no logs", async () => {
    const installed = use([runViewRule(failingRun())])
    const result = await run({ method: "view", run: "1", wait: 0, log_lines: 0 })
    expect(result.failed_logs).toEqual([])
    expect(logCalls(installed.calls())).toEqual([])
  })

  test("waits until the run completes", async () => {
    const installed = use([
      runViewRule(rawRun(1, { status: "in_progress", conclusion: "", jobs: [] }), 1),
      runViewRule(rawRun(1, { jobs: [] })),
    ])
    const result = await run({ method: "view", run: "1", wait: 2 })
    expect(result.waited).toEqual({ seconds: expect.any(Number), polls: 2, ended_by: "settled" })
    expect(result.run?.status).toBe("completed")
    expect(result.hints).toEqual([])
    expect(installed.calls()).toHaveLength(2)
  })

  test("a wait that runs out says so and hints to call again", async () => {
    use([runViewRule(rawRun(1, { status: "in_progress", conclusion: "", jobs: [] }))])
    const result = await run({ method: "view", run: "1", wait: 1 })
    expect(result.waited?.ended_by).toBe("timeout")
    expect(result.waited?.polls).toBeGreaterThanOrEqual(2)
    expect(result.hints).toEqual(["The run is still going; call again to keep waiting."])
  })

  test.each(["waiting", "action_required"])("a %s run is read once, with a hint about approval", async (status) => {
    const installed = use([runViewRule(rawRun(1, { status, conclusion: "", jobs: [] }))])
    const result = await run({ method: "view", run: "1", wait: 30 })
    expect(result.waited).toEqual({ seconds: expect.any(Number), polls: 1, ended_by: "not_waiting" })
    expect(result.hints).toHaveLength(1)
    expect(result.hints![0]).toContain("approve")
    expect(installed.calls()).toHaveLength(1)
  })

  test("a run URL names its repository, whatever follows the id", async () => {
    const installed = use([runViewRule(rawRun(7, { jobs: [] }))])
    const url = "https://github.com/Other/Repo/actions/runs/7/job/456?pr=3#step:1"
    const result = await run({ method: "view", run: url, repo: "other/repo", wait: 0 })
    expect(result.repo).toBe("Other/Repo")
    expect(installed.calls()[0]!.slice(0, 5)).toEqual(["run", "view", "7", "--repo", "Other/Repo"])
    await run({ method: "view", run: "https://github.com/Other/Repo/actions/runs/7/attempts/2", wait: 0 })
  })

  test("a URL of another repository than repo is refused", async () => {
    use([])
    const error = await failure(
      run({ method: "view", run: "https://github.com/a/b/actions/runs/7", repo: "c/d", wait: 0 }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("is in a/b, but repo is c/d")
  })

  test.each([
    "abc",
    "0",
    "-3",
    "1.5",
    "https://example.com/a/b/actions/runs/7",
    "https://github.com/a/b/pull/7",
    "https://github.com/a/b/actions/runs/x",
  ])("bad run %p", async (value) => {
    use([])
    const error = await failure(run({ method: "view", run: value, wait: 0 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("run must be a workflow run id or its URL")
  })

  test.each([undefined, "", "  "])("missing run %p", async (value) => {
    const error = await failure(run({ method: "view", run: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("needs `run`")
  })

  test("a missing run is not_found and names the run and the repository", async () => {
    use([{ match: "^run view", stderr: "failed to get run: HTTP 404: Not Found (https://api.github.com/x)", code: 1 }])
    const error = await failure(run({ method: "view", run: "9", wait: 0 }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Workflow run 9 was not found in octo/hello, or the viewer cannot see it.")
  })

  test("a log that cannot be read is reported in its entry", async () => {
    use([runViewRule(failingRun()), { match: "^run view --job", stderr: "log expired", code: 1 }])
    const result = await run({ method: "view", run: "1", wait: 0 })
    expect(result.failed_logs?.[0]?.error).toBe("upstream_error: gh failed (exit 1): log expired")
  })
})

test.each([
  [{ method: "list", run: "1" }, "run", "view", "list"],
  [{ method: "view", run: "1", branch: "main" }, "branch", "list", "view"],
  [{ method: "view", run: "1", limit: 3 }, "limit", "list", "view"],
  [{ method: "list", wait: 3 }, "wait", "view", "list"],
])("refuses an argument of another method: %j", async (args, name, owner, method) => {
  const error = await failure(run(args))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(`"${name}" is an argument of method "${owner}", not "${method}"; leave it out.`)
})
