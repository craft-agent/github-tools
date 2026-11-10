import { describe, expect, test } from "bun:test"
import * as issues from "./core/issues/describe.fixtures"
import * as projects from "./core/projects/describe.fixtures"
import * as pullRequests from "./core/pull-requests/describe.fixtures"
import * as releases from "./core/releases/describe.fixtures"
import * as repos from "./core/repos/describe.fixtures"
import * as runs from "./core/runs/describe.fixtures"
import * as workflows from "./core/workflows/describe.fixtures"
import { FACT_TRANSLATIONS } from "./core/facts"
import { STATE_WORDS } from "./core/write-facts"
import type { CallDescription } from "./core/tool"
import { describedWords, toolWords } from "./testing/tool-words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

/** The longest the whole matrix of described calls may take: a few hundred calls, each with its own fake `gh`. */
const MATRIX_TIMEOUT_MS = 600_000

/** The words of every case of one directory's matrix, described one at a time. */
function matrixWords<Case>(
  cases: Record<string, Case>,
  describeCase: (item: Case) => Promise<CallDescription | undefined>,
): () => Promise<string[]> {
  return async () => {
    const words: string[] = []
    for (const item of Object.values(cases)) words.push(...describedWords(await describeCase(item)))
    return words
  }
}

/** Every English word any tool writes: titles, intents and the words of every described case. */
async function writtenWords(): Promise<Set<string>> {
  const words = new Set(toolWords(ALL_TOOLS))
  // One matrix at a time, one case at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const matrix of [
    matrixWords(issues.DESCRIBE_CASES, issues.describeCase),
    matrixWords(pullRequests.DESCRIBE_CASES, pullRequests.describeCase),
    matrixWords(projects.DESCRIBE_CASES, projects.describeCase),
    matrixWords(repos.DESCRIBE_CASES, repos.describeCase),
    matrixWords(releases.DESCRIBE_CASES, releases.describeCase),
    matrixWords(runs.DESCRIBE_CASES, runs.describeCase),
    matrixWords(workflows.DESCRIBE_CASES, workflows.describeCase),
  ]) {
    for (const word of await matrix()) words.add(word)
  }
  return words
}

/** What `stateFact` can produce for a state that no case happens to reach. */
const STATE_FACT_WORDS = Object.values(STATE_WORDS)

describe("ALL_TRANSLATIONS usage", () => {
  test(
    "holds a Japanese word for every word the tools write, and no word that none of them writes",
    async () => {
      const written = await writtenWords()
      const keys = Object.keys(ALL_TRANSLATIONS.ja!)

      expect(
        [...written].filter((word) => !Object.hasOwn(ALL_TRANSLATIONS.ja!, word)).sort(),
        "words with no Japanese",
      ).toEqual([])

      const starter = new Set(Object.keys(FACT_TRANSLATIONS.ja!))
      const stateWords = new Set(STATE_FACT_WORDS)
      expect(
        keys.filter((key) => !written.has(key) && !starter.has(key) && !stateWords.has(key)).sort(),
        "unused keys",
      ).toEqual([])
    },
    MATRIX_TIMEOUT_MS,
  )

  test("keeps the four state words stateFact can produce", () => {
    expect([...STATE_FACT_WORDS].sort()).toEqual(["Closed", "Draft", "Merged", "Open"])
    for (const word of STATE_FACT_WORDS) expect(Object.hasOwn(ALL_TRANSLATIONS.ja!, word), word).toBe(true)
  })

  test("has no two keys that differ only in letter case or surrounding whitespace", () => {
    const seen = new Map<string, string>()
    for (const key of Object.keys(ALL_TRANSLATIONS.ja!)) {
      const folded = key.trim().toLowerCase()
      expect(seen.get(folded), `"${key}" and "${seen.get(folded)}"`).toBeUndefined()
      seen.set(folded, key)
    }
  })
})
