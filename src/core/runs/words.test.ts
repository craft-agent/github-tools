import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { DESCRIBE_CASES, describeCase, type DescribeCase } from "./describe.fixtures"
import { runCancel } from "./run-cancel"
import { runRead } from "./run-read"
import { runRerun } from "./run-rerun"
import { RUN_TRANSLATIONS } from "./words"

const SPECS = [runRead, runRerun, runCancel]

/** Every English word the run tools write: titles, intents, and the words of each described call. */
async function runWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values<DescribeCase>(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("RUN_TRANSLATIONS", () => {
  test("translates exactly the words of the run tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await runWords()).filter((english) => !shared.has(english))
    expect(Object.keys(RUN_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(RUN_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
