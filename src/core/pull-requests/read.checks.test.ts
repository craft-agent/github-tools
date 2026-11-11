import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  CHECKS,
  RUN_LIST,
  RUN_VIEW,
  apiCalls,
  checksRule,
  failure,
  logLine,
  rawChecksPullRequest,
  rawCheckRun,
  rawStatusContext,
  variable,
} from "../../testing/pull-request-fixtures"
import { invoke } from "../tool"
import { prRead } from "./read"

let repo: TempRepo
let fake: FakeGh | undefined
beforeEach(() => {
  repo = tempRepo("https://github.com/octo/hello.git")
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
const read = (args: Record<string, unknown>) =>
  invoke(prRead, { method: "checks", pr: "7", ...args }, { cwd: repo.dir })
const failing = (name: string, job: number) => rawCheckRun(name, job, { conclusion: "FAILURE" })
const running = (name: string, job: number) => rawCheckRun(name, job, { status: "IN_PROGRESS", conclusion: null })
const logRule = (job: number, log: string): GhRule => ({ match: `${RUN_VIEW} --job ${job} `, stdout: log })
const noRuns: GhRule = { match: RUN_LIST, stdout: "[]" }
const logCalls = (installed: FakeGh) => installed.calls().filter((args) => args[0] === "run" && args[1] === "view")

test("wait 0 reads once and maps the checks", async () => {
  const installed = useFake([
    checksRule(
      rawChecksPullRequest([
        rawCheckRun("build", 101, { isRequired: true }),
        running("test", 102),
        rawCheckRun("lint", 103, { conclusion: "SKIPPED", checkSuite: { workflowRun: null }, detailsUrl: null }),
        rawStatusContext("ci/legacy", { state: "PENDING", targetUrl: "https://ci.example/1" }),
      ]),
    ),
  ])
  expect(await read({ wait: 0 })).toEqual({
    repo: "octo/hello",
    pr: {
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
      state: "open",
      draft: false,
      head: "fix",
      head_sha: "abc123",
    },
    checks: {
      overall: "pending",
      pass: 1,
      fail: 0,
      pending: 2,
      skipping: 1,
      required_fail: 0,
      required_pending: 0,
      truncated: false,
    },
    check_runs: [
      {
        name: "build",
        workflow: "CI",
        bucket: "pass",
        required: true,
        state: "success",
        url: "https://github.com/octo/hello/actions/runs/1/job/101",
      },
      {
        name: "test",
        workflow: "CI",
        bucket: "pending",
        required: false,
        state: "in_progress",
        url: "https://github.com/octo/hello/actions/runs/1/job/102",
      },
      { name: "lint", workflow: null, bucket: "skipping", required: false, state: "skipped", url: null },
      {
        name: "ci/legacy",
        workflow: null,
        bucket: "pending",
        required: false,
        state: "pending",
        url: "https://ci.example/1",
      },
    ],
    failed_logs: [],
    waited: { seconds: expect.any(Number), polls: 1, ended_by: "not_waiting" },
    hints: [],
  })
  expect(apiCalls(installed)).toHaveLength(1)
  const query = variable(apiCalls(installed)[0]!, "query")!
  expect(query).toContain("lastCommit: commits(last:1)")
  expect(query).toContain("checkSuite{workflowRun{databaseId workflow{name}}}")
  expect(variable(apiCalls(installed)[0]!, "n")).toBe("7")
})

test("a cancelled check is a failure", async () => {
  useFake([checksRule(rawChecksPullRequest([rawCheckRun("build", 101, { conclusion: "CANCELLED" })]))])
  const result = await read({ wait: 0, log_lines: 0 })
  expect(result.check_runs?.[0]?.bucket).toBe("fail")
  expect(result.checks?.overall).toBe("fail")
})

test("waits until the checks settle", async () => {
  const installed = useFake([
    checksRule(rawChecksPullRequest([running("build", 101)]), 1),
    checksRule(rawChecksPullRequest([rawCheckRun("build", 101)])),
  ])
  const result = await read({ wait: 2 })
  expect(result.waited?.ended_by).toBe("settled")
  expect(result.waited?.polls).toBe(2)
  expect(result.waited?.seconds).toBeGreaterThanOrEqual(1)
  expect(result.checks?.overall).toBe("pass")
  expect(result.hints).toEqual([])
  expect(apiCalls(installed)).toHaveLength(2)
})

test("fail_fast stops at the first failure while another check runs", async () => {
  const installed = useFake([
    checksRule(rawChecksPullRequest([failing("build", 101), running("test", 102)])),
    logRule(101, logLine("##[error]boom")),
  ])
  const result = await read({ wait: 30 })
  expect(result.waited).toEqual({ seconds: expect.any(Number), polls: 1, ended_by: "failed" })
  expect(result.checks?.overall).toBe("fail")
  expect(result.failed_logs?.map((log) => log.job)).toEqual([101])
  expect(apiCalls(installed)).toHaveLength(1)
})

test("without fail_fast it keeps waiting until the checks settle", async () => {
  useFake([
    checksRule(rawChecksPullRequest([failing("build", 101), running("test", 102)]), 1),
    checksRule(rawChecksPullRequest([failing("build", 101), rawCheckRun("test", 102)])),
  ])
  const result = await read({ wait: 2, fail_fast: false, log_lines: 0 })
  expect(result.waited?.ended_by).toBe("settled")
  expect(result.waited?.polls).toBe(2)
  expect(result.checks?.overall).toBe("fail")
})

test("a wait that runs out says so and hints to call again", async () => {
  useFake([checksRule(rawChecksPullRequest([running("build", 101)]))])
  const result = await read({ wait: 1 })
  expect(result.waited?.ended_by).toBe("timeout")
  expect(result.waited?.polls).toBeGreaterThanOrEqual(2)
  expect(result.waited?.seconds).toBeGreaterThanOrEqual(1)
  expect(result.hints).toEqual(["The checks are still running; call again to keep waiting."])
})

test.each(["CLOSED", "MERGED"])("a %s pull request is read once", async (state) => {
  const installed = useFake([checksRule(rawChecksPullRequest([running("build", 101)], { state }))])
  const result = await read({ wait: 30 })
  expect(result.pr?.state).toBe(state.toLowerCase())
  expect(result.waited).toEqual({ seconds: expect.any(Number), polls: 1, ended_by: "not_waiting" })
  expect(result.hints).toEqual([])
  expect(apiCalls(installed)).toHaveLength(1)
})

test("a pull request with no checks is polled until the deadline, and hints when the branch has no run", async () => {
  const installed = useFake([checksRule(rawChecksPullRequest([])), noRuns])
  const result = await read({ wait: 1 })
  expect(result.checks?.overall).toBe("none")
  expect(result.waited?.ended_by).toBe("timeout")
  expect(result.waited?.polls).toBeGreaterThanOrEqual(2)
  expect(result.hints).toEqual([
    "No workflow run exists for this branch: the repository may have no CI for it, or a run is waiting for approval.",
  ])
  expect(installed.calls().filter((args) => args[0] === "run")).toEqual([
    ["run", "list", "--repo", "octo/hello", "--branch", "fix", "--limit", "1", "--json", "databaseId"],
  ])
})

test("no hint about runs when the branch has one", async () => {
  useFake([checksRule(rawChecksPullRequest([])), { match: RUN_LIST, stdout: '[{"databaseId":5}]' }])
  expect((await read({ wait: 0 })).hints).toEqual([])
})

test("no run lookup for a pull request that is not open", async () => {
  const installed = useFake([checksRule(rawChecksPullRequest([], { state: "CLOSED" })), noRuns])
  expect((await read({ wait: 0 })).hints).toEqual([])
  expect(installed.calls().filter((args) => args[0] === "run")).toEqual([])
})

test("a run lookup that fails adds no hint and does not fail the call", async () => {
  useFake([checksRule(rawChecksPullRequest([])), { match: RUN_LIST, stderr: "boom", code: 1 }])
  expect((await read({ wait: 0 })).hints).toEqual([])
})

test("a run lookup that is not authenticated fails the call", async () => {
  useFake([
    checksRule(rawChecksPullRequest([])),
    { match: RUN_LIST, stderr: "To get started with GitHub CLI, please run: gh auth login", code: 1 },
  ])
  expect((await failure(read({ wait: 0 }))).code).toBe("unauthenticated")
})

test("more checks than were read add a hint", async () => {
  useFake([checksRule(rawChecksPullRequest([rawCheckRun("build", 101)], {}, true))])
  const result = await read({ wait: 0 })
  expect(result.checks?.truncated).toBe(true)
  expect(result.hints).toEqual(["The pull request has more than 100 checks; only the first 100 were read."])
})

test("the log of a failed job is cut to its errors and tail", async () => {
  const errors = Array.from({ length: 12 }, (_, i) => logLine(`##[error]problem ${i}`))
  const log = [
    logLine("start"),
    "build\tRun tests\t2026-11-01T00:00:00Z ",
    "no tabs here",
    "2026-11-01T00:00:00.5Z stamped only",
    "one\ttab",
    ...errors,
    logLine("##[error]Process completed with exit code 1."),
    "",
  ].join("\n")
  useFake([checksRule(rawChecksPullRequest([failing("build", 101)])), logRule(101, log)])
  const [entry] = (await read({ wait: 0, log_lines: 3 })).failed_logs!
  expect(entry).toEqual({
    name: "build",
    job: 101,
    url: "https://github.com/octo/hello/actions/runs/1/job/101",
    errors: Array.from({ length: 10 }, (_, i) => `problem ${i}`),
    tail: "##[error]problem 10\n##[error]problem 11\n##[error]Process completed with exit code 1.",
    error: null,
  })
  const all = (await read({ wait: 0, log_lines: 500 })).failed_logs![0]!
  expect(all.tail.split("\n").slice(0, 4)).toEqual(["start", "no tabs here", "stamped only", "one\ttab"])
  expect(all.tail.split("\n")).toHaveLength(4 + 12 + 1)
})

test("an aggregate job is dropped when a job of its own failed", async () => {
  const installed = useFake([
    checksRule(
      rawChecksPullRequest([failing("Required checks", 102), failing("build", 101), failing("all_jobs", 103)]),
    ),
    logRule(101, logLine("x")),
  ])
  const result = await read({ wait: 0 })
  expect(result.failed_logs?.map((log) => log.name)).toEqual(["build"])
  expect(logCalls(installed)).toEqual([["run", "view", "--job", "101", "--log-failed", "--repo", "octo/hello"]])
})

test("an aggregate job is read when it is the only one that failed", async () => {
  useFake([
    checksRule(rawChecksPullRequest([failing("CI success", 102), rawCheckRun("build", 101)])),
    logRule(102, logLine("##[error]needs failed")),
  ])
  const result = await read({ wait: 0 })
  expect(result.failed_logs?.map((log) => [log.name, log.errors])).toEqual([["CI success", ["needs failed"]]])
})

test("at most three jobs are read, one after another", async () => {
  const installed = useFake([
    checksRule(rawChecksPullRequest([1, 2, 3, 4, 5].map((job) => failing(`job ${job}`, job)))),
    { match: RUN_VIEW, stdout: logLine("x") },
  ])
  const result = await read({ wait: 0 })
  expect(result.failed_logs?.map((log) => log.job)).toEqual([1, 2, 3])
  expect(logCalls(installed).map((args) => args[3])).toEqual(["1", "2", "3"])
})

test("log_lines 0 reads no logs", async () => {
  const installed = useFake([checksRule(rawChecksPullRequest([failing("build", 101)]))])
  const result = await read({ wait: 0, log_lines: 0 })
  expect(result.failed_logs).toEqual([])
  expect(logCalls(installed)).toEqual([])
})

test("a failed check that is not an Actions job has no log", async () => {
  const installed = useFake([
    checksRule(
      rawChecksPullRequest([
        rawCheckRun("external", 201, { conclusion: "FAILURE", checkSuite: { workflowRun: null } }),
        rawCheckRun("no id", 202, { conclusion: "FAILURE", databaseId: null }),
        rawStatusContext("ci/legacy", { state: "FAILURE" }),
      ]),
    ),
  ])
  const result = await read({ wait: 0 })
  expect(result.checks?.fail).toBe(3)
  expect(result.failed_logs).toEqual([])
  expect(logCalls(installed)).toEqual([])
})

test("a log that cannot be read is reported in its entry", async () => {
  useFake([
    checksRule(rawChecksPullRequest([failing("build", 101), failing("test", 102)])),
    { match: `${RUN_VIEW} --job 101 `, stderr: "log expired", code: 1 },
    logRule(102, logLine("##[error]fine")),
  ])
  const result = await read({ wait: 0 })
  expect(result.failed_logs).toEqual([
    {
      name: "build",
      job: 101,
      url: "https://github.com/octo/hello/actions/runs/1/job/101",
      errors: [],
      tail: "",
      error: "upstream_error: gh failed (exit 1): log expired",
    },
    expect.objectContaining({ job: 102, errors: ["fine"], error: null }),
  ])
})

test("a log read that is not authenticated fails the call", async () => {
  useFake([
    checksRule(rawChecksPullRequest([failing("build", 101)])),
    { match: RUN_VIEW, stderr: "To get started with GitHub CLI, please run: gh auth login", code: 1 },
  ])
  expect((await failure(read({ wait: 0 }))).code).toBe("unauthenticated")
})

test.each([false, true])("not_found wording, GraphQL error: %p", async (graphqlError) => {
  useFake([
    graphqlError
      ? { match: CHECKS, stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve" }]) }
      : checksRule(null),
  ])
  const error = await failure(read({ pr: "99" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe(
    "Pull request octo/hello#99 was not found: it does not exist, is an issue, or the viewer cannot see it.",
  )
})

test.each([undefined, "", "   "])("missing pr %p", async (pr) => {
  const error = await failure(read({ pr }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('method "checks" needs `pr`: 12, #12, owner/repo#12 or its URL.')
})

test("an aborted wait stops with the abort error", async () => {
  useFake([checksRule(rawChecksPullRequest([running("build", 101)]))])
  const controller = new AbortController()
  const pending = invoke(prRead, { method: "checks", pr: "7", wait: 30 }, { cwd: repo.dir, signal: controller.signal })
  setTimeout(() => controller.abort(), 500)
  const error = await pending.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect((error as Error).name).toBe("AbortError")
})

test.each([
  ["view", { wait: 5 }, "wait", "checks"],
  ["view", { log_lines: 5 }, "log_lines", "checks"],
  ["checks", { paths: ["src"] }, "paths", "diff"],
  ["checks", { patch: false }, "patch", "diff"],
  ["checks", { comments: 3 }, "comments", "view"],
  ["diff", { fail_fast: false }, "fail_fast", "checks"],
])("%s refuses an argument of another method: %j", async (method, extra, name, owner) => {
  const error = await failure(invoke(prRead, { method, pr: "7", ...extra }, { cwd: repo.dir }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(`"${name}" is an argument of method "${owner}", not "${method}"; leave it out.`)
})

test.each([{ wait: -1 }, { wait: 601 }, { wait: 1.5 }, { log_lines: -1 }, { log_lines: 501 }])(
  "invalid %j",
  async (extra) => {
    expect((await failure(read(extra))).code).toBe("invalid_argument")
  },
)
