import { z } from "zod"
import { cancelRun, parseRunRef, readRun } from "../github/workflow-runs"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { githubTargets } from "../github/targets"
import { confirmWrite, defineTool } from "../tool"
import { describedRun, statusFact } from "./describe-support"

const CANCELLATION_HINT = "Cancelling takes a moment; read the run with github_run_read view to see it end."

const input = z.object({
  run: z.string().describe("A workflow run id, or its URL."),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  run: z.number().int().describe("The workflow run id."),
  status: z.string().describe("The run's status right after requesting cancellation; cancelling takes a moment."),
  url: z.string().describe("The run's page on GitHub."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
  hints: z.array(z.string()).optional().describe("What to do next, when there is something."),
})

export const runCancel = defineTool({
  id: "github_run_cancel",
  title: "Cancel a workflow run",
  intent: "About to cancel a workflow run",
  description:
    "Cancel a workflow run that is in progress or queued. Refuses a run that has already completed. Stopping jobs cannot be undone, and a deployment may be left half done. Read the final state with github_run_read view.",
  toolset: "actions",
  class: "administrative",
  targets: githubTargets({ run: "run", repo: "repo" }),
  async describe(args, ctx) {
    const { repo, current } = await describedRun(args, ctx)
    if (current.status === "completed") {
      throw invalid(
        `Workflow run ${current.id} of ${repo.full} ended ${current.conclusion ?? "completed"}; nothing to cancel.`,
      )
    }
    return {
      headline: { text: "About to cancel the run of the workflow {name}", values: { name: current.workflow } },
      facts: [
        { label: "Branch", value: current.branch },
        { label: "Event", value: current.event },
        statusFact(current.status),
      ],
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const parsed = await parseRunRef(args.run, args.repo, ctx)
    const context = await writableContext(parsed.repo, ctx)
    const repo = context.repo
    const current = await readRun(repo, parsed.run, undefined, ctx)

    if (current.status === "completed") {
      throw invalid(
        `Workflow run ${current.id} of ${repo.full} ended ${current.conclusion ?? "completed"}; nothing to cancel.`,
      )
    }

    await confirmWrite(
      runCancel,
      ctx,
      `Cancel "${current.workflow}" run ${current.id} (${current.status}, ${current.event} on ${current.branch}) in ${repo.full}? Its jobs stop where they are, and a deploy may be left half done.`,
    )

    await cancelRun(repo, current.id, ctx)

    const after = await readRun(repo, current.id, undefined, ctx)
    const hints: string[] = []
    if (after.status !== "completed" && after.status !== "cancelled") {
      hints.push(CANCELLATION_HINT)
    }

    return {
      repo: repo.full,
      run: current.id,
      status: after.status,
      url: after.url,
      foreign: context.foreign,
      ...(hints.length > 0 ? { hints } : {}),
    }
  },
})
