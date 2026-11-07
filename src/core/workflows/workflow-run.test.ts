import { describe, expect, test } from "bun:test"
import { defaultBranchRule } from "../../testing/develop-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { branchRule, gitRefTagRule, restNotFound } from "../../testing/releases-fixtures"
import { rawRun, runViewRule } from "../../testing/runs-fixtures"
import {
  CI,
  DEPLOY,
  LISTING,
  dispatchCalls,
  dispatchRefusal,
  dispatchRule,
  workflowListRule,
} from "../../testing/workflow-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { workflowRun } from "./workflow-run"

const { use, run } = writeHarness(workflowRun)

const MAIN = "1111111111222222222233333333334444444444"
const MOVED = "5555555555666666666677777777778888888888"
const TAG = "9999999999aaaaaaaaaabbbbbbbbbbcccccccccc"
const RUN_ID = 777
const RUN_URL = `https://github.com/octo/hello/actions/runs/${RUN_ID}`

/** A repository whose default branch `main` is at `MAIN`, with a workflow listing, and `gh` printing the run's URL. Rules put in front of these answer first. */
const base = (...extra: GhRule[]): GhRule[] => [
  repositoryRule(),
  workflowListRule(LISTING),
  defaultBranchRule("main"),
  branchRule("main", MAIN),
  runViewRule(rawRun(RUN_ID, { headSha: MAIN, event: "workflow_dispatch" })),
  dispatchRule(`${RUN_URL}\n`),
  ...extra,
]

const confirming = (answer: boolean, requests: ConfirmRequest[], args: Record<string, unknown>) =>
  invoke(workflowRun, args, {
    cwd: process.cwd(),
    confirm: async (request) => {
      requests.push(request)
      return answer
    },
  })

test("starts the workflow on the default branch, sending inputs as strings on stdin", async () => {
  const installed = use(base())
  const result = await run({ workflow: "ci.yml", inputs: { env: "prod", count: 3, dry: false } })
  expect(result).toEqual({
    repo: "octo/hello",
    workflow: { id: 5, name: "CI", path: ".github/workflows/ci.yml" },
    ref: "main",
    commit: MAIN,
    run: { id: RUN_ID, url: RUN_URL },
    hints: [],
    foreign: false,
  })
  const [call, ...rest] = dispatchCalls(installed)
  expect(rest).toEqual([])
  expect(call!.args).toEqual(["workflow", "run", "5", "--repo", "octo/hello", "--ref", "main", "--json"])
  expect(JSON.parse(call!.stdin)).toEqual({ env: "prod", count: "3", dry: "false" })
})

test("keeps an @ value as data: it goes in the JSON, not on the command line", async () => {
  const installed = use(base())
  await run({ workflow: "5", inputs: { notes: "@/etc/passwd" } })
  const [call] = dispatchCalls(installed)
  expect(call!.args).not.toContain("@/etc/passwd")
  expect(JSON.parse(call!.stdin)).toEqual({ notes: "@/etc/passwd" })
})

test("sends no --json and no stdin without inputs", async () => {
  const installed = use(base())
  await run({ workflow: "ci.yml", inputs: {} })
  expect(dispatchCalls(installed)).toEqual([
    { args: ["workflow", "run", "5", "--repo", "octo/hello", "--ref", "main"], stdin: "" },
  ])
})

test("starts on a tag when no branch has the name", async () => {
  const lightweight = gitRefTagRule("v1.0.0", { object: { sha: TAG, type: "commit" } })
  const installed = use(base(restNotFound("branches/v1.0.0"), lightweight))
  const result = await run({ workflow: "ci.yml", ref: " v1.0.0 " })
  expect(result.ref).toBe("v1.0.0")
  expect(result.commit).toBe(TAG)
  expect(dispatchCalls(installed)[0]!.args).toContain("v1.0.0")
})

test("a ref that is no branch or tag is not_found and starts nothing", async () => {
  const installed = use(base(restNotFound("branches/nope"), restNotFound("git/ref/tags/nope")))
  const error = await failure(run({ workflow: "ci.yml", ref: "nope" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe("octo/hello has no branch or tag nope.")
  expect(dispatchCalls(installed)).toEqual([])
})

test("a repository without a default branch asks for a ref", async () => {
  const installed = use([repositoryRule(), workflowListRule(LISTING), defaultBranchRule(null)])
  const error = await failure(run({ workflow: "ci.yml" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain("no default branch")
  expect(dispatchCalls(installed)).toEqual([])
})

test("refuses a workflow that is not active", async () => {
  const installed = use(base())
  const error = await failure(run({ workflow: "deploy.yml" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toContain(`is ${DEPLOY.state}, not active`)
  expect(dispatchCalls(installed)).toEqual([])
})

describe("head_sha", () => {
  test("starts when the ref is at the commit, however the SHA is cased", async () => {
    const installed = use(base())
    await run({ workflow: "ci.yml", head_sha: MAIN.toUpperCase() })
    expect(dispatchCalls(installed)).toHaveLength(1)
  })

  test("stops with stale when the ref moved, starting nothing", async () => {
    const installed = use(base())
    const error = await failure(run({ workflow: "ci.yml", head_sha: MOVED }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      "main of octo/hello is at 111111111122, not 555555555566: it moved since it was read. Nothing was started.",
    )
    expect(dispatchCalls(installed)).toEqual([])
  })

  test.each(["abc123", MAIN.slice(1), `${MAIN}0`, "z".repeat(40), "  "])(
    "refuses %p before reading anything",
    async (sha) => {
      const installed = use(base())
      const error = await failure(run({ workflow: "ci.yml", head_sha: sha }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("40 hexadecimal")
      expect(sent(installed)).toEqual([])
    },
  )
})

test("a declined confirmation starts nothing; the question names the inputs, cutting a long value", async () => {
  const installed = use(base())
  const requests: ConfirmRequest[] = []
  const error = await failure(
    confirming(false, requests, { workflow: "ci.yml", inputs: { env: "prod", note: `a${"b".repeat(100)}` } }),
  )
  expect(error.code).toBe("declined")
  expect(requests).toEqual([
    {
      tool: "github_workflow_run",
      message: `Start the workflow "CI" (.github/workflows/ci.yml) on main at 111111111122 in octo/hello with env=prod, note=a${"b".repeat(59)}…? It runs whatever the workflow does, a deploy or a publish included.`,
    },
  ])
  expect(dispatchCalls(installed)).toEqual([])
})

test("the question lists no inputs when there are none", async () => {
  use(base())
  const requests: ConfirmRequest[] = []
  await confirming(true, requests, { workflow: "ci.yml" })
  expect(requests[0]!.message).toBe(
    'Start the workflow "CI" (.github/workflows/ci.yml) on main at 111111111122 in octo/hello? It runs whatever the workflow does, a deploy or a publish included.',
  )
})

describe("GitHub refuses the start", () => {
  test.each([
    ['Unexpected inputs provided: ["bogus"]', 'Unexpected inputs provided: ["bogus"]'],
    [
      "Provided value 'maybe' for input 'outcome' not in the list of allowed values",
      "Provided value 'maybe' for input 'outcome' not in the list of allowed values",
    ],
    ["No ref found for: nope", "No ref found for: nope"],
    ["Workflow does not have 'workflow_dispatch' trigger", "Workflow does not have 'workflow_dispatch' trigger"],
  ])("%s", async (reason, words) => {
    const installed = use([dispatchRefusal(reason), ...base()])
    const error = await failure(run({ workflow: "ci.yml", inputs: { bogus: "x" } }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(words)
    expect(dispatchCalls(installed)).toHaveLength(1)
  })
})

describe("the run it started", () => {
  test("is null, with a hint, when gh prints no URL", async () => {
    use([dispatchRule(""), ...base()])
    const result = await run({ workflow: "ci.yml" })
    expect(result.run).toBeNull()
    expect(result.hints).toEqual([
      "GitHub did not say which run it started; find it with github_run_read list (workflow, event workflow_dispatch).",
    ])
  })

  test("is null when the URL printed is of another repository", async () => {
    use([dispatchRule("https://github.com/other/repo/actions/runs/1\n"), ...base()])
    expect((await run({ workflow: "ci.yml" })).run).toBeNull()
  })

  test("takes the last URL gh printed", async () => {
    use([dispatchRule(`Created workflow_dispatch event\n${RUN_URL}\n`), ...base()])
    expect((await run({ workflow: "ci.yml" })).run).toEqual({ id: RUN_ID, url: RUN_URL })
  })

  test("hints that the ref moved when the run is for another commit", async () => {
    use([runViewRule(rawRun(RUN_ID, { headSha: MOVED })), ...base()])
    const result = await run({ workflow: "ci.yml" })
    expect(result.run).toEqual({ id: RUN_ID, url: RUN_URL })
    expect(result.hints).toEqual(["main moved as the workflow started: the run is for 555555555566, not 111111111122."])
  })

  test("a failed read of it is reported under errors.run and does not fail the call", async () => {
    use([{ match: "^run view", stderr: "HTTP 404: Not Found", code: 1 }, ...base()])
    const result = await run({ workflow: "ci.yml" })
    expect(result.run).toEqual({ id: RUN_ID, url: RUN_URL })
    expect(result.errors?.run).toStartWith("not_found: ")
    expect(result.hints).toEqual([])
  })

  test("a rate limit while reading it still fails the call", async () => {
    use([{ match: "^run view", stderr: "HTTP 429: rate limit exceeded", code: 1 }, ...base()])
    const error = await failure(run({ workflow: "ci.yml" }))
    expect(error.code).toBe("rate_limited")
  })
})

test("says foreign for a repository the viewer does not own", async () => {
  const installed = use([
    repositoryRule({ repo: "other/repo", viewer: "me" }),
    workflowListRule([CI]),
    defaultBranchRule("main"),
    branchRule("main", MAIN),
    dispatchRule(""),
  ])
  const result = await run({ workflow: "ci.yml", repo: "other/repo" })
  expect(result.foreign).toBe(true)
  expect(dispatchCalls(installed)[0]!.args).toEqual(["workflow", "run", "5", "--repo", "other/repo", "--ref", "main"])
})
