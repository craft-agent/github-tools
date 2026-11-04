import { isBareNumber, parseNumberRef, type RefContext, type RepoName } from "../refs"

/** The issue a reference names, with the repository that holds it. */
export type IssueRef = { repo: RepoName; number: number }

/**
 * Resolves an issue a tool relates to its target (`parent`, `blocked_by`,
 * `duplicate_of`). A bare number means `target`, not the working tree's
 * repository; `owner/repo#12` and URLs name their own, so an issue of another
 * repository is allowed. No call to GitHub is made.
 */
export async function resolveRelatedIssue(ref: string, target: RepoName, ctx: RefContext): Promise<IssueRef> {
  const text = ref.trim()
  return parseNumberRef(text, isBareNumber(text) ? target.full : undefined, ctx, { accept: "issue" })
}

/** `owner/repo#12`: the form a result names an issue in. */
export function issueLabel(issue: IssueRef): string {
  return `${issue.repo.full}#${issue.number}`
}

/**
 * The reference to hand `gh` for an issue while it works on `target`: the
 * number within the same repository, else the URL, which works across
 * repositories.
 */
export function ghIssueRef(issue: IssueRef, target: RepoName): string {
  return issue.repo.full.toLowerCase() === target.full.toLowerCase()
    ? String(issue.number)
    : `https://github.com/${issue.repo.full}/issues/${issue.number}`
}
