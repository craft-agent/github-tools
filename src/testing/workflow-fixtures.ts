import type { FakeGh, GhRule } from "./fake-gh"

/** Replies of GitHub for the tests of the workflow tools. */

export const CI = { id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" }
export const DEPLOY = { id: 6, name: "Deploy", path: ".github/workflows/deploy.yml", state: "disabled_manually" }
export const LISTING = [CI, DEPLOY]

/** The `gh workflow list` reply. */
export const workflowListRule = (workflows: unknown[]): GhRule => ({
  match: "^workflow list",
  stdout: JSON.stringify(workflows),
})

/** The `gh workflow run` reply: `stdout` is what `gh` prints, the new run's URL on a `gh` that does. */
export const dispatchRule = (stdout = ""): GhRule => ({ match: "^workflow run", stdout })

/** A `gh workflow run` that GitHub refuses with HTTP 422 and `reason`, in the shape `gh` reports it. */
export const dispatchRefusal = (reason: string, workflow = CI.id): GhRule => ({
  match: "^workflow run",
  stderr: `could not create workflow dispatch event: HTTP 422: ${reason} (https://api.github.com/repos/octo/hello/actions/workflows/${workflow}/dispatches)`,
  code: 1,
})

/** The `gh workflow run` calls a fake `gh` saw, each with what it received on stdin. */
export function dispatchCalls(installed: FakeGh): { args: string[]; stdin: string }[] {
  const stdins = installed.stdins()
  return installed
    .calls()
    .flatMap((args, index) =>
      args[0] === "workflow" && args[1] === "run" ? [{ args, stdin: stdins[index] ?? "" }] : [],
    )
}
