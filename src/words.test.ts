import { describe, expect, test } from "bun:test"
import { templatePlaceholders } from "./core/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { WRITE_FACT_TRANSLATIONS } from "./core/write-facts"
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

  test("holds the title and the intent of every write tool and the shared fact words in Japanese", () => {
    const keys = new Set(Object.keys(ALL_TRANSLATIONS.ja!))
    for (const word of toolWords(ALL_TOOLS)) expect(keys.has(word), word).toBe(true)
    for (const word of [...Object.keys(WRITE_FACT_TRANSLATIONS.ja!), ...Object.keys(FACT_TRANSLATIONS.ja!)]) {
      expect(keys.has(word), word).toBe(true)
    }
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
