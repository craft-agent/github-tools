import type { FakeGh, GhRule } from "./fake-gh"

/** A workflow run as `gh run list/view --json` prints it. */
export const rawRun = (id: number, extra: Record<string, unknown> = {}) => ({
  attempt: 1,
  conclusion: "success",
  createdAt: "2026-11-01T00:00:00Z",
  databaseId: id,
  displayTitle: `Run ${id}`,
  event: "push",
  headBranch: "main",
  headSha: "abc123",
  name: "CI",
  number: 5,
  startedAt: "2026-11-01T00:00:05Z",
  status: "completed",
  updatedAt: "2026-11-01T00:05:00Z",
  url: `https://github.com/octo/hello/actions/runs/${id}`,
  workflowDatabaseId: 99,
  workflowName: "CI",
  ...extra,
})

/** A job of a run as `gh run view --json jobs` prints it. */
export const rawJob = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  databaseId: id,
  name,
  status: "completed",
  conclusion: "success",
  startedAt: "2026-11-01T00:00:06Z",
  completedAt: "2026-11-01T00:04:00Z",
  url: `https://github.com/octo/hello/actions/runs/1/job/${id}`,
  steps: [{ name: "Set up job", conclusion: "success" }],
  ...extra,
})

/** What `expectedRun` gives for `rawRun(id)`. */
export const expectedRun = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  workflow: "CI",
  workflow_id: 99,
  title: `Run ${id}`,
  number: 5,
  attempt: 1,
  status: "completed",
  conclusion: "success",
  event: "push",
  branch: "main",
  head_sha: "abc123",
  created_at: "2026-11-01T00:00:00Z",
  started_at: "2026-11-01T00:00:05Z",
  updated_at: "2026-11-01T00:05:00Z",
  url: `https://github.com/octo/hello/actions/runs/${id}`,
  ...extra,
})

export const runListRule = (runs: unknown[]): GhRule => ({ match: "^run list", stdout: JSON.stringify(runs) })

export const runViewRule = (run: unknown, times?: number): GhRule => ({
  match: "^run view \\d+ ",
  stdout: JSON.stringify(run),
  times,
})

/** A rule matching `gh run cancel`. */
export const cancelRule: GhRule = { match: "^run cancel" }

/** A rule matching `gh run rerun`. */
export const rerunRule: GhRule = { match: "^run rerun" }

/** The `gh run cancel` calls a fake `gh` saw. */
export function cancelCalls(fake: FakeGh): string[][] {
  return fake.calls().filter((c) => c[0] === "run" && c[1] === "cancel")
}

/** The `gh run rerun` calls a fake `gh` saw. */
export function rerunCalls(fake: FakeGh): string[][] {
  return fake.calls().filter((c) => c[0] === "run" && c[1] === "rerun")
}
