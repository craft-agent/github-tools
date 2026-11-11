import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { ghIssueRef, issueLabel, resolveRelatedIssue, type IssueRef } from "../github/issue-refs"
import { MAX_DEPENDENCIES, MAX_SUB_ISSUES, issueBriefSchema, readIssue, type IssueBrief } from "../github/issues"
import { assertWritable, repositoryContext, type RepositoryContext } from "../github/repository"
import { parseNumberRef, type RepoName } from "../refs"
import { githubTargets } from "../github/targets"
import { defineTool, type CallFact, type ToolContext } from "../tool"
import { changeFact } from "../write-facts"
import { ISSUE_DESCRIPTION, ISSUE_TARGETS, describedIssue, editIssue } from "./write-support"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../write-support"

const REFERENCE_FORMS = "12, #12, owner/repo#12 or its URL; a bare number means the issue's repository."

/**
 * What GitHub says when an add names a link that is there already, which counts
 * as unchanged: one wording for sub-issues and the parent, one for dependencies.
 * Any other refusal is a failure. (Removing a link that is not there is not
 * refused at all.)
 */
const DUPLICATE_SUB_ISSUE = /duplicate sub-issues/i
const DUPLICATE_DEPENDENCY = /Target issue has already been taken/i

/**
 * The relations that are lists: the argument and `gh issue edit` flag of each
 * change, the refusal that means "there already", and the page size of the
 * read of the current list.
 */
const LISTS = [
  {
    name: "sub_issues",
    add: "add_sub_issues",
    remove: "remove_sub_issues",
    addFlag: "--add-sub-issue",
    removeFlag: "--remove-sub-issue",
    duplicate: DUPLICATE_SUB_ISSUE,
    pageSize: MAX_SUB_ISSUES,
    dependency: false,
  },
  {
    name: "blocked_by",
    add: "add_blocked_by",
    remove: "remove_blocked_by",
    addFlag: "--add-blocked-by",
    removeFlag: "--remove-blocked-by",
    duplicate: DUPLICATE_DEPENDENCY,
    pageSize: MAX_DEPENDENCIES,
    dependency: true,
  },
  {
    name: "blocking",
    add: "add_blocking",
    remove: "remove_blocking",
    addFlag: "--add-blocking",
    removeFlag: "--remove-blocking",
    duplicate: DUPLICATE_DEPENDENCY,
    pageSize: MAX_DEPENDENCIES,
    dependency: true,
  },
] as const

type ListName = (typeof LISTS)[number]["name"]

/** The fact label of each list relation. */
const RELATION_LABELS: Record<ListName, string> = {
  sub_issues: "Sub-issues",
  blocked_by: "Blocked by",
  blocking: "Blocking",
}

const input = z.object({
  issue: z.string().describe(ISSUE_DESCRIPTION),
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  parent: z.string().optional().describe(`The issue to set as the parent: ${REFERENCE_FORMS}`),
  remove_parent: z.boolean().optional().describe("Take the issue out of its parent; not with parent."),
  add_sub_issues: z.array(z.string()).optional().describe(`Issues to add as sub-issues: ${REFERENCE_FORMS}`),
  remove_sub_issues: z.array(z.string()).optional(),
  add_blocked_by: z.array(z.string()).optional().describe("Issues that block this one, in the same forms."),
  remove_blocked_by: z.array(z.string()).optional(),
  add_blocking: z.array(z.string()).optional().describe("Issues this one blocks, in the same forms."),
  remove_blocking: z.array(z.string()).optional(),
})

const changesSchema = z.object({
  added: z.array(z.string()).describe("owner/repo#N of each issue that was added."),
  removed: z.array(z.string()).describe("owner/repo#N of each issue that was removed."),
  unchanged: z.array(z.string()).describe("Asked for, but already so; nothing was sent for them."),
})

const output = z.object({
  repo: z.string(),
  issue: z.number().int(),
  parent: z.object({
    before: issueBriefSchema.nullable().describe("The parent before the call."),
    after: z.string().nullable().describe("owner/repo#N of the parent now; null when it has none."),
    changed: z.boolean(),
  }),
  sub_issues: changesSchema,
  blocked_by: changesSchema,
  blocking: changesSchema,
  other_repos: z
    .array(z.object({ repo: z.string(), foreign: z.boolean() }))
    .describe("The other repositories the relations name, each checked for write permission."),
  foreign: z.boolean(),
})

type Args = z.output<typeof input>
type Changes = z.output<typeof changesSchema>
type Wanted = { add: IssueRef[]; remove: IssueRef[] }

/** The arguments of one call, checked, with every issue resolved. */
type Request = { parent?: IssueRef; removeParent: boolean; lists: Record<ListName, Wanted> }

const issueKey = (ref: IssueRef): string => `${ref.repo.full.toLowerCase()}#${ref.number}`
const briefKey = (brief: IssueBrief): string => `${brief.repo.toLowerCase()}#${brief.number}`
const briefLabel = (brief: IssueBrief): string => `${brief.repo}#${brief.number}`
const isEmpty = (wanted: Wanted): boolean => wanted.add.length === 0 && wanted.remove.length === 0

function perList<T>(make: () => T): Record<ListName, T> {
  return Object.fromEntries(LISTS.map((list) => [list.name, make()])) as Record<ListName, T>
}

/** The issues of a list argument, resolved against `target`, without blanks or repeats. */
async function resolveList(
  refs: readonly string[] | undefined,
  target: RepoName,
  ctx: ToolContext,
): Promise<IssueRef[]> {
  const resolved = new Map<string, IssueRef>()
  for (const text of refs ?? []) {
    const ref = given(text)
    if (!ref) continue
    const issue = await resolveRelatedIssue(ref, target, ctx)
    resolved.set(issueKey(issue), issue)
  }
  return [...resolved.values()]
}

/** Refuses what cannot describe one change, before any call to GitHub. */
async function parseRequest(args: Args, issue: IssueRef, ctx: ToolContext): Promise<Request> {
  const parentText = given(args.parent)
  if (args.parent !== undefined && !parentText) {
    throw invalid("parent is blank; pass the parent issue, or remove_parent to take the issue out of its parent.")
  }
  const removeParent = Boolean(args.remove_parent)
  if (parentText && removeParent) throw invalid("parent and remove_parent contradict each other; pass one of them.")

  const request: Request = {
    parent: parentText ? await resolveRelatedIssue(parentText, issue.repo, ctx) : undefined,
    removeParent,
    lists: perList(() => ({ add: [], remove: [] })),
  }
  for (const list of LISTS) {
    const wanted: Wanted = {
      add: await resolveList(args[list.add], issue.repo, ctx),
      remove: await resolveList(args[list.remove], issue.repo, ctx),
    }
    const removing = new Set(wanted.remove.map(issueKey))
    const both = wanted.add.filter((ref) => removing.has(issueKey(ref)))
    if (both.length) {
      throw invalid(`${list.name}: ${both.map(issueLabel).join(", ")} cannot be both added and removed.`)
    }
    request.lists[list.name] = wanted
  }

  const named = [request.parent, ...LISTS.flatMap((list) => Object.values(request.lists[list.name]).flat())]
  if (named.some((ref) => ref && issueKey(ref) === issueKey(issue))) {
    throw invalid("An issue cannot be related to itself.")
  }
  const nothing = !request.parent && !removeParent && LISTS.every((list) => isEmpty(request.lists[list.name]))
  if (nothing) {
    throw invalid(
      "Nothing to change: pass parent, remove_parent, or at least one issue to add or remove as a sub-issue, blocked-by or blocking.",
    )
  }
  return request
}

/**
 * The other repositories the request names, each read once with the viewer's
 * permission there, and the target's own; keyed by lower-cased name as the
 * request spells it. Throws `forbidden` for the first one the viewer may not write to.
 */
async function checkRepositories(
  request: Request,
  target: RepositoryContext,
  ctx: ToolContext,
): Promise<Map<string, RepositoryContext>> {
  const contexts = new Map([[target.repo.full.toLowerCase(), target]])
  const named = [
    request.parent,
    ...LISTS.flatMap((list) => [...request.lists[list.name].remove, ...request.lists[list.name].add]),
  ]
  for (const ref of named) {
    if (!ref || contexts.has(ref.repo.full.toLowerCase())) continue
    const context = await repositoryContext(ref.repo, ctx)
    assertWritable(context)
    contexts.set(ref.repo.full.toLowerCase(), context)
  }
  return contexts
}

/** The error of a failed change, saying what the call had changed before it and that a rerun is safe. */
function partialFailure(error: unknown, applied: readonly string[]): unknown {
  if (!isToolError(error)) return error
  const done = applied.length ? applied.join("; ") : "nothing"
  return new ToolError(
    error.code,
    `${error.message} Applied before this failure: ${done}. The relations are read afresh on every call, so rerunning the same call is safe: it sends only what is still missing.`,
    { cause: error },
  )
}

export const issueRelate = defineTool({
  id: "github_issue_relate",
  title: "Relate GitHub issues",
  intent: "About to change how GitHub issues are related",
  description: [
    "Set an issue's parent (parent or remove_parent), sub-issues, blocked-by and blocking issues (add_ and remove_ lists) in one call.",
    "It reads the current relations first and sends only the difference, so a rerun is safe; what already holds is listed as unchanged.",
    "GitHub allows 100 sub-issues per parent, all of one owner. Every other repository named needs write permission too and is listed in other_repos.",
    "An issue is 12, #12, owner/repo#12 or its URL; a bare number means the issue's repository.",
  ].join(" "),
  toolset: "issues",
  class: "idempotent",
  targets: githubTargets({
    ...ISSUE_TARGETS,
    parent: "issue",
    add_sub_issues: "issues",
    remove_sub_issues: "issues",
    add_blocked_by: "issues",
    remove_blocked_by: "issues",
    add_blocking: "issues",
    remove_blocking: "issues",
  }),
  async describe(args, ctx) {
    const { ref, heading } = await describedIssue(args, ctx)
    const request = await parseRequest(args, ref, ctx)
    const facts: CallFact[] = []
    if (request.parent) facts.push({ label: "Parent", value: issueLabel(request.parent) })
    if (request.removeParent) facts.push({ label: "Parent", value: { text: "Removed" } })
    for (const list of LISTS) {
      const wanted = request.lists[list.name]
      const fact = changeFact(RELATION_LABELS[list.name], wanted.add.map(issueLabel), wanted.remove.map(issueLabel))
      if (fact) facts.push(fact)
    }

    return {
      headline: { text: "About to change the relations of the issue {title}", values: { title: heading.title } },
      facts,
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const ref = await parseNumberRef(args.issue, args.repo, ctx, { accept: "issue" })
    const request = await parseRequest(args, ref, ctx)

    const context = await writableContext(ref.repo, ctx)
    const target = context.repo
    const issue: IssueRef = { repo: target, number: ref.number }
    const repositories = await checkRepositories(request, context, ctx)
    const named = (other: IssueRef): string =>
      issueLabel({ repo: repositories.get(other.repo.full.toLowerCase())?.repo ?? other.repo, number: other.number })

    const current = await readIssue(issue, { comments: 0 }, ctx)
    const needsDependencies = LISTS.some((list) => list.dependency && !isEmpty(request.lists[list.name]))
    if (needsDependencies && current.dependencies_error) {
      throw new ToolError(
        "upstream_error",
        `Blocked-by and blocking of ${issueLabel(issue)} cannot be changed here: GitHub could not return its current dependencies (${current.dependencies_error}). Nothing was changed; sub-issues and the parent can still be changed without them.`,
      )
    }

    const applied: string[] = []
    // Sends one change; `false` when GitHub refuses it with the `tolerated` wording: the link was there already.
    const send = async (flags: string[], what: string, tolerated?: RegExp): Promise<boolean> => {
      try {
        await editIssue(target, issue.number, flags, ctx)
      } catch (error) {
        if (isToolError(error) && error.code === "upstream_error" && tolerated?.test(error.message)) return false
        throw partialFailure(error, applied)
      }
      applied.push(what)
      return true
    }

    const currentParent = current.parent
    let parentAfter = currentParent ? briefLabel(currentParent) : null
    let parentChanged = false
    if (request.removeParent) {
      if (currentParent) {
        parentChanged = await send(["--remove-parent"], `--remove-parent ${briefLabel(currentParent)}`)
      }
      parentAfter = null
    } else if (request.parent) {
      parentAfter = named(request.parent)
      if (!currentParent || briefKey(currentParent) !== issueKey(request.parent)) {
        parentChanged = await send(
          ["--parent", ghIssueRef(request.parent, target)],
          `--parent ${parentAfter}`,
          DUPLICATE_SUB_ISSUE,
        )
      }
    }

    const changes = perList<Changes>(() => ({ added: [], removed: [], unchanged: [] }))
    for (const list of LISTS) {
      const have = new Set(current[list.name].map(briefKey))
      // A full page may hide issues that are linked, so a removal that does not find its issue is sent anyway.
      const full = current[list.name].length >= list.pageSize
      const result = changes[list.name]
      const wanted = request.lists[list.name]
      for (const other of wanted.remove) {
        const label = named(other)
        const sent =
          (have.has(issueKey(other)) || full) &&
          (await send([list.removeFlag, ghIssueRef(other, target)], `${list.removeFlag} ${label}`))
        ;(sent ? result.removed : result.unchanged).push(label)
      }
      for (const other of wanted.add) {
        const label = named(other)
        const sent =
          !have.has(issueKey(other)) &&
          (await send([list.addFlag, ghIssueRef(other, target)], `${list.addFlag} ${label}`, list.duplicate))
        ;(sent ? result.added : result.unchanged).push(label)
      }
    }

    return {
      repo: target.full,
      issue: issue.number,
      parent: { before: currentParent, after: parentAfter, changed: parentChanged },
      ...changes,
      other_repos: [...repositories.values()]
        .filter((other) => other !== context)
        .map((other) => ({ repo: other.repo.full, foreign: other.foreign })),
      foreign: context.foreign,
    }
  },
})
