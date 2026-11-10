import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { projectCreate } from "./create"
import { DESCRIBE_CASES, describeCase, type DescribeCase } from "./describe.fixtures"
import { projectFieldEnsure } from "./field-ensure"
import { projectItemAdd } from "./item-add"
import { projectItemArchive, projectItemUnarchive } from "./item-archive"
import { projectItemConvert } from "./item-convert"
import { projectItemCreate } from "./item-create"
import { projectItemEdit } from "./item-edit"
import { projectLink, projectUnlink } from "./link"
import { projectRead } from "./read"
import { projectViewEnsure } from "./view-ensure"
import { PROJECT_TRANSLATIONS } from "./words"

const SPECS = [
  projectRead,
  projectCreate,
  projectLink,
  projectUnlink,
  projectFieldEnsure,
  projectViewEnsure,
  projectItemAdd,
  projectItemCreate,
  projectItemEdit,
  projectItemArchive,
  projectItemUnarchive,
  projectItemConvert,
]

/** Every English word the project tools write: titles, intents, and the words of each described call. */
async function projectWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values<DescribeCase>(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("PROJECT_TRANSLATIONS", () => {
  test("translates exactly the words of the project tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await projectWords()).filter((english) => !shared.has(english))
    expect(Object.keys(PROJECT_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(PROJECT_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
