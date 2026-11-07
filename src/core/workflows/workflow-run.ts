import { z } from "zod"
import { ToolError } from "../errors"
import { branchHead, defaultBranch } from "../github/branches"
import { tagCommit } from "../github/releases"
import { parseRunUrl, readRun, softFailure } from "../github/workflow-runs"
import { dispatchWorkflow, resolveWorkflow } from "../github/workflows"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../issues/write-support"
import { resolveRepo, SHA_PATTERN, shortSha, type RefContext, type RepoName } from "../refs"
import { confirmWrite, defineTool } from "../tool"

/** The longest input value, in characters, the confirmation shows. */
const MAX_SHOWN_VALUE = 60
/** The most inputs the confirmation lists. */
const MAX_SHOWN_INPUTS = 10
const ACTIVE_STATE = "active"
const UNKNOWN_RUN_HINT =
  "GitHub did not say which run it started; find it with github_run_read list (workflow, event workflow_dispatch)."

const input = z.object({
  workflow: z.string().describe("A workflow's id, file name (ci.yml), path or name."),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  ref: z
    .string()
    .optional()
    .describe("The branch or tag holding the workflow file to run; default the repository's default branch."),
  inputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "The workflow_dispatch inputs by name, as {name: value}; read the names from github_workflow_read view's file. GitHub takes every value as a string, so numbers and booleans are sent as text.",
    ),
  head_sha: z
    .string()
    .optional()
    .describe(
      "Optional 40-character commit SHA the ref was read at. Fails with stale, starting nothing, if the ref is at another commit.",
    ),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  workflow: z
    .object({
      id: z.number().int().describe("The workflow id."),
      name: z.string().describe("The workflow's name."),
      path: z.string().describe("The workflow file's path."),
    })
    .describe("The workflow that was started."),
  ref: z.string().describe("The branch or tag the workflow was started on."),
  commit: z.string().describe("The commit the ref was at when the check was made."),
  run: z
    .object({
      id: z.number().int().describe("The workflow run id."),
      url: z.string().describe("The run's page on GitHub."),
    })
    .nullable()
    .describe("The run GitHub started; null when it did not say which."),
  hints: z.array(z.string()).describe("What to know or do next, when there is something."),
  errors: z
    .object({ run: z.string().optional().describe("Why the run could not be read afterwards, as code: message.") })
    .optional()
    .describe("Steps after the start that failed; the run was started all the same."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
})

/** The commit `ref` names: a branch's head, else a tag's commit; `not_found` when it is neither. */
async function refCommit(repo: RepoName, ref: string, ctx: RefContext): Promise<string> {
  const commit = (await branchHead(repo, ref, ctx)) ?? (await tagCommit(repo, ref, ctx))
  if (!commit) throw new ToolError("not_found", `${repo.full} has no branch or tag ${ref}.`)
  return commit
}

/** The inputs as GitHub takes them: every value a string. */
function inputStrings(inputs: Record<string, string | number | boolean> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs ?? {}).map(([name, value]) => [name, String(value)]))
}

function shownValue(value: string): string {
  const text = value.replace(/\s+/g, " ")
  return text.length > MAX_SHOWN_VALUE ? `${text.slice(0, MAX_SHOWN_VALUE)}…` : text
}

/** ` with name=value, …` for the confirmation, bounded; empty for no inputs. */
function describeInputs(inputs: Record<string, string>): string {
  const entries = Object.entries(inputs)
  if (entries.length === 0) return ""
  const shown = entries.slice(0, MAX_SHOWN_INPUTS).map(([name, value]) => `${name}=${shownValue(value)}`)
  const more = entries.length > shown.length ? `, and ${entries.length - shown.length} more` : ""
  return ` with ${shown.join(", ")}${more}`
}

/** The run `gh` printed the URL of, when it printed one of this repository. */
function startedRun(stdout: string, repo: RepoName): { id: number; url: string } | null {
  for (const line of stdout.split("\n").reverse()) {
    const parsed = parseRunUrl(line)
    if (parsed && parsed.repo.full.toLowerCase() === repo.full.toLowerCase()) {
      return { id: parsed.run, url: line.trim() }
    }
  }
  return null
}

export const workflowRun = defineTool({
  id: "github_workflow_run",
  title: "Start a GitHub Actions workflow",
  description:
    "Start a workflow by hand (a workflow_dispatch run) at a branch or tag (ref, default the default branch), with inputs. GitHub checks the inputs and the ref, and its refusal is returned. It runs whatever the workflow does, a deploy or a publish included, and cannot be undone in effect. Refuses a workflow that is not active. With head_sha it stops with stale, starting nothing, if ref is at another commit; the start names the ref, not the commit, so a push right after the check still runs the newer commit (the run's commit is checked afterwards and a hint says so). Read the run with github_run_read view, which waits.",
  toolset: "actions",
  class: "administrative",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const workflow = await resolveWorkflow(repo, args.workflow, ctx)
    if (workflow.state !== ACTIVE_STATE) {
      throw invalid(
        `Workflow "${workflow.name}" (${workflow.path}) of ${repo.full} is ${workflow.state}, not ${ACTIVE_STATE}; enable it on GitHub first.`,
      )
    }

    const ref = given(args.ref) ?? (await defaultBranch(repo, ctx))
    if (!ref) {
      throw invalid(`${repo.full} has no default branch (it may be empty); give a ref.`)
    }
    const commit = await refCommit(repo, ref, ctx)
    if (expectedSha && commit.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `${ref} of ${repo.full} is at ${shortSha(commit)}, not ${shortSha(expectedSha)}: it moved since it was read. Nothing was started.`,
      )
    }

    const inputs = inputStrings(args.inputs)
    await confirmWrite(
      workflowRun,
      ctx,
      `Start the workflow "${workflow.name}" (${workflow.path}) on ${ref} at ${shortSha(commit)} in ${repo.full}${describeInputs(inputs)}? It runs whatever the workflow does, a deploy or a publish included.`,
    )

    const printed = await dispatchWorkflow(repo, workflow.id, ref, inputs, ctx)
    const run = startedRun(printed, repo)
    const hints: string[] = []
    const errors: { run?: string } = {}
    if (!run) {
      hints.push(UNKNOWN_RUN_HINT)
    } else {
      // The run exists now, so a failed read must not fail the call.
      try {
        const started = await readRun(repo, run.id, undefined, ctx)
        if (started.head_sha.toLowerCase() !== commit.toLowerCase()) {
          hints.push(
            `${ref} moved as the workflow started: the run is for ${shortSha(started.head_sha)}, not ${shortSha(commit)}.`,
          )
        }
      } catch (error) {
        const failure = softFailure(error)
        errors.run = `${failure.code}: ${failure.message}`
      }
    }

    return {
      repo: repo.full,
      workflow: { id: workflow.id, name: workflow.name, path: workflow.path },
      ref,
      commit,
      run,
      hints,
      ...(errors.run === undefined ? {} : { errors }),
      foreign: context.foreign,
    }
  },
})
