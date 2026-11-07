import { ToolError } from "./errors"
import { assertWritable, repositoryContext, type RepositoryContext } from "./github/repository"
import type { RepoName } from "./refs"
import type { ToolContext } from "./tool"

/** What the write tools of every domain share: argument checks, the permission gate and reading what gh printed. */

export const REPO_DESCRIPTION =
  "owner/name; defaults to the working tree's repository (its origin). Used for a bare number."

/** `gh` reads `--label` and `--assignee` values as CSV: a comma splits one name into two, and a quote or a line break is syntax. */
const LIST_SYNTAX = /[,"\r\n]/
const URL_LINE = /^https?:\/\/\S+$/
const BODY_SEPARATOR = "\n\n"

export function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** An argument's text with its surrounding space removed; blank counts as not given. */
export function given(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** The names of a list argument, trimmed and without blanks or repeats; a name `gh` would split is refused. */
export function nameList(argument: string, values: readonly string[] | undefined): string[] {
  const names = new Set<string>()
  for (const value of values ?? []) {
    const name = value.trim()
    if (LIST_SYNTAX.test(name)) {
      throw invalid(
        `${argument}: ${JSON.stringify(name)} contains a comma, a double quote or a line break, which gh reads as list syntax.`,
      )
    }
    if (name) names.add(name)
  }
  return [...names]
}

/** The permission gate every write passes before it changes anything: the repository's context, once the viewer may write there. */
export async function writableContext(repo: RepoName, ctx: ToolContext): Promise<RepositoryContext> {
  const context = await repositoryContext(repo, ctx)
  assertWritable(context)
  return context
}

/** The last line of `stdout` that is a URL, which is where `gh` prints what it made or changed. */
export function lastUrl(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => URL_LINE.test(line))
}

/** `current` and `added` apart by a blank line; an empty body takes the text alone. */
export function appended(current: string, added: string): string {
  const body = current.trimEnd()
  return body ? `${body}${BODY_SEPARATOR}${added}` : added
}
