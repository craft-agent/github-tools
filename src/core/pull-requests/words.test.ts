import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { prClose } from "./close"
import { prComment } from "./comment"
import { prCreate } from "./create"
import { DESCRIBE_CASES, describeCase, type DescribeCase } from "./describe.fixtures"
import { prEdit } from "./edit"
import { prMerge } from "./merge"
import { prRead } from "./read"
import { prReady } from "./ready"
import { prReopen } from "./reopen"
import { prReview } from "./review"
import { stackLink } from "./stack-link"
import { stackRead } from "./stack-read"
import { stackUnlink } from "./stack-unlink"
import { PULL_REQUEST_TRANSLATIONS } from "./words"

const SPECS = [
  prRead,
  prCreate,
  prEdit,
  prComment,
  prReady,
  prClose,
  prReopen,
  prReview,
  prMerge,
  stackRead,
  stackLink,
  stackUnlink,
]

/** Every English word the pull request tools write: titles, intents, and the words of each described call. */
async function pullRequestWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values<DescribeCase>(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("PULL_REQUEST_TRANSLATIONS", () => {
  test("translates exactly the words of the pull request tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await pullRequestWords()).filter((english) => !shared.has(english))
    expect(Object.keys(PULL_REQUEST_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(PULL_REQUEST_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
