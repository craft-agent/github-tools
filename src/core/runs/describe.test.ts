import { describe, expect, test } from "bun:test"
import { queryOf } from "../../testing/setup-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { DESCRIBE_CASES, HEAD_SHA, describeCase, runRules, type DescribeCase } from "./describe.fixtures"

/** The methods of a `gh api` call that change something, and the `gh` commands that do. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
const WRITE_COMMANDS = [
  ["run", "cancel"],
  ["run", "rerun"],
  ["workflow", "run"],
]

const NOT_WRITABLE = repositoryRule({ permission: "READ" })
const branch = (name: string) => ({ label: "Branch", value: name })
const scope = (word: string) => ({ label: "Scope", value: { text: word } })

describe("github_run_cancel", () => {
  const headline = { text: "About to cancel the run of the workflow {name}", values: { name: "CI" } }

  test("a queued run: its branch, event and status", async () => {
    expect(await describeCase(DESCRIBE_CASES.cancelQueued)).toEqual({
      headline,
      facts: [branch("main"), { label: "Event", value: "push" }, { label: "Status", value: { text: "Queued" } }],
    })
  })

  test("a run in progress, named by its URL, with the workflow's name from the run", async () => {
    expect(await describeCase(DESCRIBE_CASES.cancelInProgress)).toEqual({
      headline: { ...headline, values: { name: "Deploy" } },
      facts: [
        branch("feature/x"),
        { label: "Event", value: "pull_request" },
        { label: "Status", value: { text: "In progress" } },
      ],
    })
  })

  test("another status is shown as GitHub gives it", async () => {
    const item = DESCRIBE_CASES.cancelQueued
    const description = await describeCase({ ...item, rules: runRules({ status: "waiting", conclusion: null }) })
    expect(description?.facts[2]).toEqual({ label: "Status", value: "waiting" })
  })

  const cancel = DESCRIBE_CASES.cancelQueued
  test.each([
    ["a run that has completed", cancel.args, runRules()],
    ["a run that is no run reference", { run: "abc" }, cancel.rules],
    ["a run that does not exist", cancel.args, [repositoryRule(), { match: "^run view", stderr: "HTTP 404", code: 1 }]],
    ["a repository the viewer cannot write to", cancel.args, [NOT_WRITABLE, ...cancel.rules.slice(1)]],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...cancel, args, rules })).toBeUndefined()
  })
})

describe("github_run_rerun", () => {
  const headline = { text: "About to re-run the workflow {name}", values: { name: "CI" } }
  const pins = { head_sha: HEAD_SHA, attempt: "2" }

  test("the failed jobs, the default, with the commit and attempt pinned", async () => {
    expect(await describeCase(DESCRIBE_CASES.rerunFailed)).toEqual({
      headline,
      facts: [branch("main"), scope("Failed jobs only")],
      pins,
    })
  })

  test("every job with debug logging", async () => {
    expect(await describeCase(DESCRIBE_CASES.rerunAll)).toEqual({
      headline,
      facts: [branch("main"), scope("All jobs"), { label: "Debug logging", value: { text: "On" } }],
      pins,
    })
  })

  test("one job, with its real name", async () => {
    expect(await describeCase(DESCRIBE_CASES.rerunJob)).toEqual({
      headline,
      facts: [branch("main"), scope("One job"), { label: "Job", value: "build" }],
      pins,
    })
  })

  test("the pins follow the run's commit and attempt", async () => {
    const item = DESCRIBE_CASES.rerunAll
    const rules = runRules({ headSha: "9".repeat(40), attempt: 5 })
    expect((await describeCase({ ...item, rules }))?.pins).toEqual({ head_sha: "9".repeat(40), attempt: "5" })
  })

  const rerun = DESCRIBE_CASES.rerunFailed
  test.each([
    ["a run that is still going", rerun.args, runRules({ status: "in_progress", conclusion: null })],
    ["job with failed_only", { run: "777", job: 11, failed_only: true }, rerun.rules],
    ["a job the run does not have", { run: "777", job: 99 }, rerun.rules],
    ["failed jobs of a run where nothing failed", rerun.args, runRules()],
    ["a run that does not exist", rerun.args, [repositoryRule(), { match: "^run view", stderr: "HTTP 404", code: 1 }]],
    ["a repository the viewer cannot write to", rerun.args, [NOT_WRITABLE, ...rerun.rules.slice(1)]],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...rerun, args, rules })).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values<DescribeCase>(DESCRIBE_CASES)

  test.each(cases.map((item) => [item.name, item] as const))("%s: is within the budgets", async (_name, item) => {
    const description = await describeCase(item)
    expect(description).toBeDefined()
    expect(Array.from(description!.headline!.text).length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH)
    expect(description!.facts.length).toBeLessThanOrEqual(MAX_FACTS)
    for (const { label } of description!.facts) expect(Array.from(label).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
  })

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: is the same when asked twice",
    async (_name, item) => {
      expect(await describeCase(item)).toEqual(await describeCase(item))
    },
  )

  test.each(cases.map((item) => [item.name, item] as const))("%s: only reads", async (_name, item) => {
    let calls: string[][] = []
    await describeCase(item, (seen) => (calls = seen))
    const isWrite = (args: string[]) =>
      queryOf(args).startsWith("mutation") ||
      WRITE_METHODS.some((method) => args.includes(method)) ||
      WRITE_COMMANDS.some(([command, verb]) => args[0] === command && args[1] === verb)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(isWrite)).toEqual([])
  })
})
