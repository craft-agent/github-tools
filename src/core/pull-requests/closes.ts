import type { IssueRef } from "../github/issue-refs"
import type { RepoName } from "../refs"
import { appended } from "../write-support"

/** Closing keywords in a pull request body: the lines that link issues GitHub closes when the pull request merges. */

const CLOSING_KEYWORD = "(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)"
const CLOSING_LINE = new RegExp(`^\\s*${CLOSING_KEYWORD}:?\\s+(\\S+)\\s*$`, "i")
const SAME_REPOSITORY_REF = /^#(\d+)$/
const QUALIFIED_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const URL_REF = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/i
const KEYWORD = "Closes"

export const CLOSES_DESCRIPTION = {
  closes:
    "Issues this pull request closes when it merges, as 12, #12, owner/repo#12 or an issue URL (a bare number means the pull request's repository): a `Closes #12` line is added to the end of the body. GitHub links them only for a pull request into the default branch.",
  add_closes:
    "Issues to close when it merges, in the same forms as closes: a `Closes #12` line is added to the end of the body unless the body has one already.",
  remove_closes:
    "Issues to stop closing: the body's lines that are only a closing keyword and that issue are removed. A mention in a sentence or a commit message is left as it is, so the issue can stay linked.",
} as const

/** The identity of an issue, the same for every way a body can name it. */
export function issueKey(repo: string, number: number | string): string {
  return `${repo.toLowerCase()}#${number}`
}

function isSameRepository(a: RepoName, b: RepoName): boolean {
  return a.full.toLowerCase() === b.full.toLowerCase()
}

/** The issue a reference in a closing line names (`#12`, `owner/name#12` or an issue URL), as its key. */
function referenceKey(reference: string, prRepo: RepoName): string | undefined {
  const same = SAME_REPOSITORY_REF.exec(reference)
  if (same) return issueKey(prRepo.full, same[1]!)
  const qualified = QUALIFIED_REF.exec(reference) ?? URL_REF.exec(reference)
  return qualified ? issueKey(qualified[1]!, qualified[2]!) : undefined
}

/** The key of the issue a line closes, or `undefined` when the line is anything but a closing keyword and one reference. */
function closedKey(line: string, prRepo: RepoName): string | undefined {
  const reference = CLOSING_LINE.exec(line)?.[1]
  return reference === undefined ? undefined : referenceKey(reference, prRepo)
}

/** `Closes #12` within the pull request's repository, else `Closes owner/name#12`. */
export function closingLine(issue: IssueRef, prRepo: RepoName): string {
  return `${KEYWORD} ${isSameRepository(issue.repo, prRepo) ? "" : issue.repo.full}#${issue.number}`
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === ""
}

/**
 * Keeps one blank line where a removal left several: at each place a line was
 * taken out (`gaps`, as indexes into `lines`), the blank lines around it become
 * one. Blank lines anywhere else stay as they are.
 */
function closeGaps(lines: readonly string[], gaps: readonly number[]): string[] {
  const result = [...lines]
  // From the last gap to the first, so a collapse does not move the places still to be visited.
  for (const at of [...new Set(gaps)].sort((a, b) => b - a)) {
    let start = at
    while (start > 0 && isBlank(result[start - 1])) start--
    let end = at
    while (end < result.length && isBlank(result[end])) end++
    if (end - start > 1) result.splice(start, end - start, result[start]!)
  }
  return result
}

/**
 * The body split into its text and the block of closing lines it ends with: the
 * run of lines at the end that are each only a closing keyword and a reference,
 * with nothing between them. Trailing whitespace is dropped; `block` is empty
 * when the body does not end with a closing line.
 */
export function splitClosingBlock(body: string, prRepo: RepoName): { text: string; block: string } {
  const lines = body.trimEnd().split("\n")
  let start = lines.length
  while (start > 0 && closedKey(lines[start - 1]!, prRepo) !== undefined) start--
  return {
    text: lines.slice(0, start).join("\n").trimEnd(),
    block: lines.slice(start).join("\n"),
  }
}

/**
 * The body with the lines that only close an issue of `remove` taken out, then
 * a closing line for each issue of `add` that the body does not close yet,
 * after the body's last line: set off by a blank line, or directly under a
 * closing line the body ends with. The body's trailing whitespace is dropped,
 * and where a removal would leave two or more blank lines in a row, one stays.
 */
export function withClosing(
  body: string,
  add: readonly IssueRef[],
  remove: readonly IssueRef[],
  prRepo: RepoName,
): string {
  const removed = new Set(remove.map((issue) => issueKey(issue.repo.full, issue.number)))
  const kept: string[] = []
  const gaps: number[] = []
  for (const line of body.split("\n")) {
    const key = closedKey(line, prRepo)
    if (key !== undefined && removed.has(key)) gaps.push(kept.length)
    else kept.push(line)
  }
  let text = closeGaps(kept, gaps).join("\n").trimEnd()

  for (const issue of add) {
    const lines = text.split("\n")
    const key = issueKey(issue.repo.full, issue.number)
    if (lines.some((line) => closedKey(line, prRepo) === key)) continue
    const line = closingLine(issue, prRepo)
    text = closedKey(lines.at(-1)!, prRepo) === undefined ? appended(text, line) : `${text}\n${line}`
  }
  return text
}
