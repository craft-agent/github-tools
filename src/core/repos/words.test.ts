import { describe, expect, test } from "bun:test"
import { describedWords, toolWords } from "../../testing/tool-words"
import { templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { WRITE_FACT_TRANSLATIONS } from "../write-facts"
import { DESCRIBE_CASES, describeCase, type DescribeCase } from "./describe.fixtures"
import { labelCreate } from "./label-create"
import { labelDelete } from "./label-delete"
import { labelEdit } from "./label-edit"
import { labelRead } from "./label-read"
import { milestoneCreate } from "./milestone-create"
import { milestoneEdit } from "./milestone-edit"
import { milestoneRead } from "./milestone-read"
import { repoArchive } from "./repo-archive"
import { repoCreate } from "./repo-create"
import { repoEdit } from "./repo-edit"
import { repoRead } from "./repo-read"
import { repoUnarchive } from "./repo-unarchive"
import { repoVisibility } from "./repo-visibility"
import { rulesetCreate } from "./ruleset-create"
import { rulesetDelete } from "./ruleset-delete"
import { rulesetEdit } from "./ruleset-edit"
import { rulesetRead } from "./ruleset-read"
import { REPO_TRANSLATIONS } from "./words"

const SPECS = [
  repoRead,
  labelRead,
  milestoneRead,
  rulesetRead,
  labelCreate,
  labelEdit,
  labelDelete,
  milestoneCreate,
  milestoneEdit,
  repoCreate,
  repoEdit,
  repoVisibility,
  repoArchive,
  repoUnarchive,
  rulesetCreate,
  rulesetEdit,
  rulesetDelete,
]

/** Every English word the repository tools write: titles, intents, and the words of each described call. */
async function repoWords(): Promise<string[]> {
  const words = new Set(toolWords(SPECS))
  // One at a time: each case puts its own fake `gh` first on the shared `PATH`.
  for (const item of Object.values<DescribeCase>(DESCRIBE_CASES)) {
    for (const word of describedWords(await describeCase(item))) words.add(word)
  }
  return [...words].sort()
}

describe("REPO_TRANSLATIONS", () => {
  test("translates exactly the words of the repository tools that no shared table holds", async () => {
    const shared = new Set([...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)])
    const expected = (await repoWords()).filter((english) => !shared.has(english))
    expect(Object.keys(REPO_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(REPO_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })
})
