import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { gh, ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { encodePathSegments } from "./branches"
import { refusalAsInvalid } from "./refusal"
import { repositoryNotFound } from "./repository"

/** Workflow reads of one repository. */

/** The most workflows `gh workflow list` is asked for; GitHub allows no more than a repository can hold in practice. */
const MAX_WORKFLOWS = 1000
/** The most workflows a refusal names. */
const MAX_LISTED_WORKFLOWS = 10
const RAW_CONTENT_ACCEPT = "Accept: application/vnd.github.raw"
const ID_PATTERN = /^\d+$/

export const workflowRowSchema = z.object({
  id: z.number().int().describe("The workflow id."),
  name: z.string().describe("The workflow's name."),
  path: z.string().describe("The workflow file's path, such as .github/workflows/ci.yml."),
  state: z.string().describe("active, disabled_manually, disabled_inactivity, …"),
})

export type WorkflowRow = z.output<typeof workflowRowSchema>

/** One workflow with its page on GitHub. */
export const workflowSchema = workflowRowSchema.extend({
  url: z.string().describe("The workflow's page on GitHub."),
})

export type Workflow = z.output<typeof workflowSchema>

type RawWorkflowDetail = WorkflowRow & { html_url: string }

/** Every workflow of the repository, disabled ones included. A missing repository is `not_found`. */
export async function listWorkflows(repo: RepoName, ctx: RefContext): Promise<WorkflowRow[]> {
  let raw: WorkflowRow[] | null
  try {
    raw = await ghJson<WorkflowRow[]>(
      [
        "workflow",
        "list",
        "--repo",
        repo.full,
        "--all",
        "--limit",
        String(MAX_WORKFLOWS),
        "--json",
        "id,name,path,state",
      ],
      ctx,
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
  return (raw ?? []).map(({ id, name, path, state }) => ({ id, name, path, state }))
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function describeWorkflow(workflow: WorkflowRow): string {
  return `${workflow.name} (${workflow.path}, id ${workflow.id})`
}

/**
 * The workflow `wanted` names: first by id or path, else by file name
 * (`ci.yml`) or name, case-insensitive. None is `not_found`, listing the
 * workflows there are; several is `invalid_argument`, listing them.
 */
export async function resolveWorkflow(repo: RepoName, wanted: string, ctx: RefContext): Promise<WorkflowRow> {
  const text = wanted.trim()
  const key = text.toLowerCase()
  const workflows = await listWorkflows(repo, ctx)
  const byIdOrPath = workflows.filter(
    (workflow) => (ID_PATTERN.test(text) && String(workflow.id) === text) || workflow.path.toLowerCase() === key,
  )
  const matches =
    byIdOrPath.length > 0
      ? byIdOrPath
      : workflows.filter(
          (workflow) => fileName(workflow.path).toLowerCase() === key || workflow.name.toLowerCase() === key,
        )
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new ToolError(
      "invalid_argument",
      `"${wanted}" matches several workflows of ${repo.full}: ${matches.map(describeWorkflow).join("; ")}. Give the id or the path.`,
    )
  }
  const shown = workflows.slice(0, MAX_LISTED_WORKFLOWS).map((workflow) => `${workflow.name} (${workflow.path})`)
  const more = workflows.length > shown.length ? `, and ${workflows.length - shown.length} more` : ""
  throw new ToolError(
    "not_found",
    shown.length === 0
      ? `${repo.full} has no workflows.`
      : `No workflow "${wanted}" in ${repo.full}. Its workflows: ${shown.join("; ")}${more}.`,
  )
}

/** One workflow, with its page on GitHub. */
export async function readWorkflow(repo: RepoName, id: number, ctx: RefContext): Promise<Workflow> {
  const raw = await ghJson<RawWorkflowDetail>(["api", `repos/${repo.owner}/${repo.name}/actions/workflows/${id}`], ctx)
  if (!raw) throw new ToolError("github_error", `GitHub returned nothing for workflow ${id} of ${repo.full}.`)
  return { id: raw.id, name: raw.name, path: raw.path, state: raw.state, url: raw.html_url }
}

/**
 * The text of a workflow file at `ref` (default the default branch), as it is
 * stored. `null` when there is no file there: the ref may not exist, or GitHub
 * made the workflow itself.
 */
export async function readWorkflowFile(
  repo: RepoName,
  path: string,
  ref: string | undefined,
  ctx: RefContext,
): Promise<string | null> {
  const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`
  try {
    return await gh(
      [
        "api",
        "-H",
        RAW_CONTENT_ACCEPT,
        `repos/${repo.owner}/${repo.name}/contents/${encodePathSegments(path)}${query}`,
      ],
      ctx,
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return null
    throw error
  }
}

/**
 * Starts a `workflow_dispatch` run of a workflow at `ref` and returns what `gh`
 * printed, which is the new run's URL on a `gh` that reports it. The inputs go
 * as JSON on stdin, never as `-f`/`-F` arguments, since `-F` reads a value that
 * starts with `@` as a file. GitHub's refusal (unknown input, ref, or a workflow
 * without the trigger) is `invalid_argument` carrying its words.
 */
export async function dispatchWorkflow(
  repo: RepoName,
  id: number,
  ref: string,
  inputs: Record<string, string>,
  ctx: RefContext,
): Promise<string> {
  const hasInputs = Object.keys(inputs).length > 0
  const args = ["workflow", "run", String(id), "--repo", repo.full, "--ref", ref]
  if (hasInputs) args.push("--json")
  return refusalAsInvalid(() => gh(args, { ...ctx, stdin: hasInputs ? JSON.stringify(inputs) : undefined }))
}
