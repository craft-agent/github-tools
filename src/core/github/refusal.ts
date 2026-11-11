import { ToolError, isToolError } from "../errors"

/** What a failed `gh api` call says of an HTTP 422, GitHub's refusal of the values a write sent. */
const VALIDATION_STATUS = /\s*\(HTTP 422\)|^HTTP 422:?\s*/
/** The form other `gh` commands print: their own words, then the status (`failed to rerun: HTTP 422: …`). */
const COMMAND_STATUS = /^[^:\n]+:\s+HTTP 422:\s*/
/** The API URL other `gh` commands print after GitHub's words. */
const TRAILING_URL = /\s*\(https?:\/\/[^\s()]+\)\s*$/
const GH_FAILURE_PREFIX = /^gh failed \(exit \d+\):\s*/
const GH_PREFIX = /^gh:\s*/
const TRAILING_STOPS = /[.:\s]+$/

/** GitHub's own words in a failure message, without the runner's prefix, `gh`'s words, the status and the URL. */
function refusalText(message: string): string {
  return message
    .replace(GH_FAILURE_PREFIX, "")
    .replace(GH_PREFIX, "")
    .replace(COMMAND_STATUS, "")
    .replace(VALIDATION_STATUS, "")
    .replace(TRAILING_URL, "")
    .replace(TRAILING_STOPS, "")
    .trim()
}

/**
 * Runs a REST write and maps GitHub's HTTP 422, which refuses the arguments
 * the write sent, to `invalid_argument` carrying GitHub's own message. Any other
 * failure passes through unchanged.
 */
export async function refusalAsInvalid<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!isToolError(error) || error.code !== "upstream_error" || !/HTTP 422/.test(error.message)) throw error
    const text = refusalText(error.message)
    throw new ToolError("invalid_argument", `GitHub refused it${text ? `: ${text}` : ""}.`, { cause: error })
  }
}
