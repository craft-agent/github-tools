import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { rawJob, rawRun, runViewRule } from "../../testing/runs-fixtures"
import { ORIGIN, repositoryRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { runCancel } from "./run-cancel"
import { runRerun } from "./run-rerun"

/** One call of a run write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The run the cases are about. */
export const RUN_ID = 777

/** The commit that run is for. */
export const HEAD_SHA = "1111111111222222222233333333334444444444"

/** The replies for a call on the run `RUN_ID`, read as `rawRun(RUN_ID, extra)` with a passing and a failing job. */
export const runRules = (extra: Record<string, unknown> = {}): GhRule[] => [
  repositoryRule(),
  runViewRule(
    rawRun(RUN_ID, {
      headSha: HEAD_SHA,
      attempt: 2,
      jobs: [rawJob(11, "build"), rawJob(12, "test", { conclusion: "failure" })],
      ...extra,
    }),
  ),
]

/** Representative calls of the run write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  cancelQueued: {
    name: "cancel a queued run",
    tool: runCancel,
    args: { run: String(RUN_ID) },
    rules: runRules({ status: "queued", conclusion: null }),
  },
  cancelInProgress: {
    name: "cancel a run in progress, named by its URL",
    tool: runCancel,
    args: { run: `https://github.com/octo/hello/actions/runs/${RUN_ID}` },
    rules: runRules({
      status: "in_progress",
      conclusion: null,
      event: "pull_request",
      headBranch: "feature/x",
      workflowName: "Deploy",
    }),
  },
  rerunFailed: {
    name: "re-run the failed jobs of a failed run, the default",
    tool: runRerun,
    args: { run: String(RUN_ID) },
    rules: runRules({ conclusion: "failure" }),
  },
  rerunAll: {
    name: "re-run every job with debug logging",
    tool: runRerun,
    args: { run: String(RUN_ID), failed_only: false, debug: true },
    rules: runRules(),
  },
  rerunJob: {
    name: "re-run one job",
    tool: runRerun,
    args: { run: String(RUN_ID), job: 11 },
    rules: runRules(),
  },
} satisfies Record<string, DescribeCase>

/**
 * Describes a case in a throwaway working tree whose origin is `octo/hello`,
 * with the fake `gh` it needs; `seen` gets the arguments of every call the
 * description made to `gh`.
 */
export async function describeCase(
  item: DescribeCase,
  seen?: (calls: string[][]) => void,
): Promise<CallDescription | undefined> {
  const repo = tempRepo(ORIGIN)
  const fake = installFakeGh(item.rules)
  try {
    return await callDescription(item.tool, item.args, { cwd: repo.dir })
  } finally {
    seen?.(fake.calls())
    fake.restore()
    repo.cleanup()
  }
}
