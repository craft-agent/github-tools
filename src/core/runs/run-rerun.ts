import { z } from "zod"
import { ToolError } from "../errors"
import { parseRunRef, readRun, rerunRun } from "../github/workflow-runs"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { shortSha } from "../refs"
import { confirmWrite, defineTool } from "../tool"

const FAILED_RUN_CONCLUSIONS: readonly string[] = ["failure", "cancelled", "timed_out", "startup_failure"]

const input = z.object({
  run: z.string().describe("A workflow run id, or its URL."),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  failed_only: z
    .boolean()
    .optional()
    .describe("Re-run only the failed jobs and the jobs that depend on them; false re-runs every job (default true)."),
  job: z
    .number()
    .int()
    .optional()
    .describe("A job id from github_run_read view; re-runs that job and the jobs that depend on it."),
  debug: z.boolean().optional().describe("Re-run with debug logging."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  run: z.number().int().describe("The workflow run id."),
  attempt: z.number().int().describe("The attempt the re-run starts: one more than the attempt re-run."),
  url: z.string().describe("The run's page on GitHub."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
})

export const runRerun = defineTool({
  id: "github_run_rerun",
  title: "Re-run a workflow run",
  intent: "About to re-run a workflow run",
  description:
    "Re-run a completed workflow run: only failed jobs (the default), a specific job, or every job. Refuses a run that is still going (use github_run_read view to wait or github_run_cancel to cancel), a run where nothing failed when failed_only is true, an unknown job, or passing both job and failed_only. Cannot be undone in effect; steps run again, including deploys and publishes. Read the outcome with github_run_read view, which waits for the run to complete.",
  toolset: "actions",
  class: "administrative",
  targets: { run: "run", repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const parsed = await parseRunRef(args.run, args.repo, ctx)
    const context = await writableContext(parsed.repo, ctx)
    const repo = context.repo
    const current = await readRun(repo, parsed.run, undefined, ctx)

    if (current.status !== "completed") {
      throw invalid(
        `Workflow run ${current.id} of ${repo.full} is still ${current.status}; wait for it to complete (github_run_read view) or cancel it (github_run_cancel).`,
      )
    }

    if (args.job !== undefined && args.failed_only !== undefined) {
      throw invalid("Pass job or failed_only, not both.")
    }

    const targetJob = args.job !== undefined ? current.jobs.find((job) => job.id === args.job) : undefined
    if (args.job !== undefined && !targetJob) {
      throw new ToolError("not_found", `Job ${args.job} was not found in workflow run ${current.id} of ${repo.full}.`)
    }

    const failedOnly = args.failed_only ?? true
    if (args.job === undefined && failedOnly) {
      if (!current.conclusion || !FAILED_RUN_CONCLUSIONS.includes(current.conclusion)) {
        throw invalid(
          `Workflow run ${current.id} of ${repo.full} ended ${current.conclusion ?? "without failure"}; nothing failed. Pass failed_only: false to re-run every job.`,
        )
      }
    }

    const shortHead = shortSha(current.head_sha)
    const runDesc = `"${current.workflow}" run ${current.id} (${current.conclusion}, ${current.event} on ${current.branch} at ${shortHead}) in ${repo.full}`
    const message = targetJob
      ? `Re-run job "${targetJob.name}" of ${runDesc}? Its steps run again, a deploy or a publish included.`
      : failedOnly
        ? `Re-run the failed jobs of ${runDesc}? Their steps run again, a deploy or a publish included.`
        : `Re-run every job of ${runDesc}? Their steps run again, a deploy or a publish included.`

    await confirmWrite(runRerun, ctx, message)

    await rerunRun(
      repo,
      current.id,
      {
        failedOnly: args.job !== undefined ? undefined : failedOnly,
        job: args.job,
        debug: args.debug,
      },
      ctx,
    )

    // GitHub numbers the attempt a moment after it accepts the re-run, so a read here can still see the old one.
    return {
      repo: repo.full,
      run: current.id,
      attempt: current.attempt + 1,
      url: current.url,
      foreign: context.foreign,
    }
  },
})
