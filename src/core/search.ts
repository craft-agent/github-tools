import { ToolError } from "./errors"

/** A GitHub login (Enterprise Managed User logins contain `_`), or `@me`. */
export const LOGIN_PATTERN = /^(?:@me|[A-Za-z0-9][A-Za-z0-9_-]{0,38})$/
/** Characters that would end or escape a quoted search value. */
const UNQUOTABLE = /["\\\r\n]/
/** A qualifier that would aim the search at another repository or owner, possibly negated or in parentheses. */
const SCOPE_QUALIFIER = /(?:^|\W)-?(?:repo|org|user):/i

/** An argument's text with its surrounding space removed; blank counts as not given. */
export function given(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

export function quoted(name: string, value: string): string {
  if (UNQUOTABLE.test(value)) {
    throw new ToolError("invalid_argument", `${name} cannot contain a double quote, a backslash or a line break.`)
  }
  return `"${value}"`
}

export function searchWords(query: string | undefined): string | undefined {
  const words = given(query)
  if (words && SCOPE_QUALIFIER.test(words)) {
    throw new ToolError(
      "invalid_argument",
      "query cannot name another repository or owner (repo:, org:, user:); list one repository per call.",
    )
  }
  return words
}
