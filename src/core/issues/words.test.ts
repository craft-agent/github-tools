import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { issueClose } from "./close"
import { issueComment } from "./comment"
import { issueCreate } from "./create"
import { DESCRIBE_CASES, describeCase } from "./describe.fixtures"
import { issueDevelop } from "./develop"
import { issueEdit } from "./edit"
import { issueRead } from "./read"
import { issueRelate } from "./relate"
import { issueReopen } from "./reopen"
import { ISSUE_TRANSLATIONS } from "./words"

const SPECS = [issueRead, issueCreate, issueEdit, issueComment, issueClose, issueReopen, issueRelate, issueDevelop]

/** Every English word the issue tools write: titles, intents, and the words of each described call. */
async function issueWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("ISSUE_TRANSLATIONS", () => {
  test("translates exactly the words of the issue tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await issueWords()).filter((english) => !shared.has(english))
    expect(Object.keys(ISSUE_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(ISSUE_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
