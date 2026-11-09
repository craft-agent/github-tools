import { describe, expect, test } from "bun:test"
import { templatePlaceholders } from "./core/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { toolWords } from "./testing/tool-words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

const WRITE_TOOLS = ALL_TOOLS.filter((spec) => spec.class !== "read")

describe("ALL_TRANSLATIONS", () => {
  test("gives every write tool an intent that starts with 'About to '", () => {
    for (const spec of WRITE_TOOLS) {
      expect(spec.intent?.trim(), spec.id).toBeTruthy()
      expect(spec.intent!.startsWith("About to "), spec.id).toBe(true)
    }
  })

  test("holds exactly the words of the tools and the shared facts in Japanese", () => {
    const expected = [...toolWords(ALL_TOOLS), ...Object.keys(FACT_TRANSLATIONS.ja!)].sort()
    expect(Object.keys(ALL_TRANSLATIONS.ja!).sort()).toEqual(expected)
  })

  test("keeps the placeholders of every template in its translation", () => {
    for (const [english, japanese] of Object.entries(ALL_TRANSLATIONS.ja!)) {
      if (!english.includes("{")) continue
      expect(templatePlaceholders(japanese), english).toEqual(templatePlaceholders(english))
    }
  })

  test("never has two tools share a title or an intent", () => {
    const words = ALL_TOOLS.flatMap((spec) => [spec.title, ...(spec.intent === undefined ? [] : [spec.intent])])
    expect(new Set(words).size).toBe(words.length)
  })

  test("translates the shared fact words", () => {
    expect(ALL_TRANSLATIONS.ja!.Size).toBe("サイズ")
  })
})
