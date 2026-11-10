import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { DESCRIBE_CASES, describeCase, type DescribeCase } from "./describe.fixtures"
import { workflowRead } from "./workflow-read"
import { workflowRun } from "./workflow-run"
import { WORKFLOW_TRANSLATIONS } from "./words"

const SPECS = [workflowRead, workflowRun]

/** Every English word the workflow tools write: titles, intents, and the words of each described call. */
async function workflowWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values<DescribeCase>(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("WORKFLOW_TRANSLATIONS", () => {
  test("translates exactly the words of the workflow tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await workflowWords()).filter((english) => !shared.has(english))
    expect(Object.keys(WORKFLOW_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(WORKFLOW_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
