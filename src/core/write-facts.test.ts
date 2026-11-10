import { describe, expect, test } from "bun:test"
import { PIN_PATTERN } from "./pin"
import { WRITE_FACT_TRANSLATIONS, changeFact, digest, stateFact } from "./write-facts"

describe("stateFact", () => {
  test.each([
    ["open", "Open"],
    ["closed", "Closed"],
    ["merged", "Merged"],
    ["draft", "Draft"],
  ])("%s is the template value %s", (state, word) => {
    expect(stateFact(state)).toEqual({ label: "State", value: { text: word } })
  })

  test("any other state is a plain string", () => {
    expect(stateFact("something_new")).toEqual({ label: "State", value: "something_new" })
    expect(stateFact("constructor")).toEqual({ label: "State", value: "constructor" })
  })
})

describe("changeFact", () => {
  test("lists additions with a plus and removals with a minus sign, additions first", () => {
    expect(changeFact("Labels", ["bug", "docs"], ["wontfix"])).toEqual({
      label: "Labels",
      value: "+bug +docs \u2212wontfix",
    })
  })

  test("lists additions alone, or removals alone", () => {
    expect(changeFact("Assignees", ["alice"])).toEqual({ label: "Assignees", value: "+alice" })
    expect(changeFact("Assignees", [], ["bob"])).toEqual({ label: "Assignees", value: "\u2212bob" })
  })

  test("is undefined when nothing is added or removed", () => {
    expect(changeFact("Labels", [])).toBeUndefined()
    expect(changeFact("Labels", [], [])).toBeUndefined()
  })

  test("leaves control characters in a name as they are", () => {
    expect(changeFact("Labels", ["a\u202eb"])?.value).toBe("+a\u202eb")
  })
})

describe("digest", () => {
  test("is the lowercase hex SHA-256 of the text", () => {
    expect(digest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(digest("abc")).toMatch(PIN_PATTERN)
  })

  test("differs for different texts and agrees for equal ones", () => {
    expect(digest("a")).not.toBe(digest("b"))
    expect(digest("a")).toBe(digest("a"))
  })
})

describe("WRITE_FACT_TRANSLATIONS", () => {
  test("translates the state words", () => {
    expect(WRITE_FACT_TRANSLATIONS.ja).toMatchObject({
      State: "状態",
      Open: "オープン",
      Closed: "クローズ",
      Merged: "マージ済み",
      Draft: "ドラフト",
      Comment: "コメント",
    })
  })
})
