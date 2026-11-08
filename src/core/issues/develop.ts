import { z } from "zod"
import { ToolError } from "../errors"
import { branchHead, defaultBranch } from "../github/branches"
import { createLinkedBranch, linkedBranchSchema, readLinkedBranches } from "../github/issues"
import { parseNumberRef, parseRepo, type RepoName } from "../refs"
import { defineTool, type ToolContext } from "../tool"
import { ISSUE_DESCRIPTION, ISSUE_TARGETS } from "./write-support"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../write-support"

/** Characters git refuses anywhere in a ref name: controls, space, and `~ ^ : ? * [ \`. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u0020\u007f~^:?*[\\]/
/** Sequences git refuses anywhere in a ref name. */
const FORBIDDEN_SEQUENCES = ["..", "@{", "//"]
const BAD_EDGES = /^[-/]|[/.]$/
const LOCK_SUFFIX = ".lock"

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  branch: z
    .string()
    .optional()
    .describe(
      "The branch name; when left out, a linked branch in the branch repository is reused, else GitHub names one.",
    ),
  base: z
    .string()
    .optional()
    .describe("The branch to start from, which must exist; defaults to the branch repository's default branch."),
  branch_repo: z
    .string()
    .optional()
    .describe("owner/name of the repository to create the branch in; defaults to the issue's repository."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  branch: z.string(),
  branch_repo: z.string().describe("owner/name of the repository that holds the branch."),
  base: z.string().nullable().describe("The branch it was started from; null for a branch that already existed."),
  created: z.boolean().describe("False when a linked branch already existed and nothing was sent."),
  linked_branches: z.array(linkedBranchSchema).describe("Every branch linked to the issue now."),
  foreign: z.boolean(),
})

/** Whether git accepts the name for a branch, by the rules of `git check-ref-format`. */
function isRefName(name: string): boolean {
  return !(
    FORBIDDEN_CHARACTERS.test(name) ||
    FORBIDDEN_SEQUENCES.some((sequence) => name.includes(sequence)) ||
    name === "@" ||
    BAD_EDGES.test(name) ||
    name.split("/").some((part) => part.startsWith(".") || part.endsWith(LOCK_SUFFIX))
  )
}

/** A branch or base name, checked; `undefined` when the argument was left out. */
function branchName(argument: "branch" | "base", value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = given(value)
  if (!name) throw invalid(`${argument} is blank; pass a branch name, or leave it out.`)
  if (!isRefName(name)) {
    throw invalid(
      `${argument}: ${JSON.stringify(name)} is not a branch name git accepts (no spaces or control characters, none of ~ ^ : ? * [ \\, no "..", "@{", "//" or a name of just "@", no leading "-" or "/", no trailing "/" or ".", and no part between slashes that starts with "." or ends with ".lock").`,
    )
  }
  return name
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The branch to start from, `base` when given, else the repository's default branch, with the commit it points at. */
async function startingPoint(
  base: string | undefined,
  repo: RepoName,
  ctx: ToolContext,
): Promise<{ name: string; oid: string }> {
  const name = base ?? (await defaultBranch(repo, ctx))
  if (!name) {
    throw new ToolError(
      "not_found",
      `${repo.full} has no default branch to start from (is it empty?); push a first commit or pass base.`,
    )
  }
  const oid = await branchHead(repo, name, ctx)
  if (!oid) throw new ToolError("not_found", `Base branch ${name} does not exist in ${repo.full}.`)
  return { name, oid }
}

export const issueDevelop = defineTool({
  id: "github_issue_develop",
  title: "Link a development branch to a GitHub issue",
  description: [
    "Create a branch on GitHub linked to an issue (its Development panel), or return the linked branch that exists already. It goes through the API: nothing is fetched or checked out locally.",
    "With branch, a linked branch of that name is reused; without it, the first linked branch in the branch repository. A new branch starts from base (it must exist) or the default branch.",
    "A pull request opened from a linked branch closes the issue when it merges, with no closing keyword; use a plain branch when the first merge should not close it.",
  ].join(" "),
  toolset: "issues",
  class: "idempotent",
  targets: { ...ISSUE_TARGETS, branch_repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const branch = branchName("branch", args.branch)
    const base = branchName("base", args.base)
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const requestedRepo = args.branch_repo === undefined ? undefined : parseRepo(args.branch_repo)

    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const issue = { repo: target, number: ref.number }
    const branchContext =
      requestedRepo && !sameRepo(requestedRepo.full, target.full) ? await writableContext(requestedRepo, ctx) : context
    const branchRepo = branchContext.repo
    const foreign = context.foreign || branchContext.foreign

    const { issueId, branches: linked } = await readLinkedBranches(issue, ctx)
    const here = linked.filter((entry) => sameRepo(entry.repo, branchRepo.full))
    const existing = branch === undefined ? here[0] : here.find((entry) => entry.name === branch)
    if (existing) {
      return {
        repo: target.full,
        issue: issue.number,
        branch: existing.name,
        branch_repo: existing.repo,
        base: null,
        created: false,
        linked_branches: linked,
        foreign,
      }
    }

    const from = await startingPoint(base, branchRepo, ctx)
    const created = await createLinkedBranch(
      { issueId, oid: from.oid, repositoryId: branchContext.id, name: branch },
      ctx,
    )
    return {
      repo: target.full,
      issue: issue.number,
      branch: created.name,
      branch_repo: created.repo,
      base: from.name,
      created: true,
      linked_branches: [...linked, created],
      foreign,
    }
  },
})
