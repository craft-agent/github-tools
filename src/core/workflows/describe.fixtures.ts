import { defaultBranchRule } from "../../testing/develop-fixtures"
import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { branchRule, gitRefTagRule, restNotFound } from "../../testing/releases-fixtures"
import { LISTING, workflowListRule } from "../../testing/workflow-fixtures"
import { ORIGIN, repositoryRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { workflowRun } from "./workflow-run"

/** One call of a workflow write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The commit the default branch `main` is at, and the one the tag `v1.0.0` names. */
export const MAIN = "1111111111222222222233333333334444444444"
export const TAGGED = "9999999999aaaaaaaaaabbbbbbbbbbcccccccccc"

/** A repository whose default branch `main` is at `MAIN`, with the workflow listing; rules put in front of these answer first. */
export const workflowRules = (...extra: GhRule[]): GhRule[] => [
  ...extra,
  repositoryRule(),
  workflowListRule(LISTING),
  defaultBranchRule("main"),
  branchRule("main", MAIN),
]

/** Representative calls of the workflow write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  runDefaultBranch: {
    name: "start a workflow on the default branch",
    tool: workflowRun,
    args: { workflow: "ci.yml" },
    rules: workflowRules(),
  },
  runTag: {
    name: "start a workflow on a tag",
    tool: workflowRun,
    args: { workflow: "CI", ref: " v1.0.0 " },
    rules: workflowRules(
      restNotFound("branches/v1.0.0"),
      gitRefTagRule("v1.0.0", { object: { sha: TAGGED, type: "commit" } }),
    ),
  },
  runWithInputs: {
    name: "start a workflow with inputs at a commit already reviewed",
    tool: workflowRun,
    args: { workflow: "5", ref: "main", head_sha: MAIN.toUpperCase(), inputs: { env: "prod", count: 3, dry: false } },
    rules: workflowRules(),
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
