import { describe, expect, test } from "bun:test"
import { appendOptions, parseOptions, replaceOptions } from "./board-options"

const option = (id: string, name: string, color = "GRAY", description = "") => ({ id, name, color, description })

describe("parseOptions", () => {
  test("a name alone is gray without a description", () => {
    expect(parseOptions(["Low"])).toEqual([{ name: "Low", color: "GRAY", description: "" }])
  })

  test("Name:COLOR, in any case, and Name:COLOR:Description with everything after the second colon", () => {
    expect(parseOptions([" High : red ", "Wait:blue:Blocked: see #4", "Plain::Only a note"])).toEqual([
      { name: "High", color: "RED", description: "" },
      { name: "Wait", color: "BLUE", description: "Blocked: see #4" },
      { name: "Plain", color: "GRAY", description: "Only a note" },
    ])
  })

  test.each([
    ["a color GitHub does not list", ["Low:TEAL"], "TEAL"],
    ["a blank name", [" :RED"], "no name"],
    ["a name given twice, in another case", ["Low", "LOW:RED"], "twice"],
  ])("%s is invalid_argument", (_what, options, message) => {
    expect(() => parseOptions(options)).toThrow(message)
  })

  test("no options are none", () => {
    expect(parseOptions(undefined)).toEqual([])
  })
})

describe("merging", () => {
  const existing = [option("o1", "Todo", "GREEN", "old"), option("o2", "Done", "PURPLE")]
  const wanted = parseOptions(["done:RED", "Waiting:GRAY:Stuck", "Todo:BLUE:Ready"])

  test("appending keeps the existing list and adds only the missing options", () => {
    const merged = appendOptions(existing, wanted)
    expect(merged.options).toEqual([...existing, { name: "Waiting", color: "GRAY", description: "Stuck" }])
    expect(merged).toMatchObject({ added: ["Waiting"], updated: [], changed: true })
    expect(appendOptions(existing, parseOptions(["todo"])).changed).toBe(false)
  })

  test("replacing is exactly the wanted list, with the ids of the options that match", () => {
    const merged = replaceOptions(existing, wanted)
    expect(merged.options).toEqual([
      { id: "o2", name: "done", color: "RED", description: "" },
      { name: "Waiting", color: "GRAY", description: "Stuck" },
      { id: "o1", name: "Todo", color: "BLUE", description: "Ready" },
    ])
    expect(merged).toMatchObject({ added: ["Waiting"], updated: ["done", "Todo"], changed: true })
  })

  test("replacing a list that already is the wanted one changes nothing", () => {
    const same = replaceOptions(existing, parseOptions(["Todo:GREEN:old", "Done:PURPLE"]))
    expect(same).toMatchObject({ added: [], updated: [], changed: false })
  })

  test("replacing counts a moved option as updated and a dropped one as a change", () => {
    expect(replaceOptions(existing, parseOptions(["Done:PURPLE", "Todo:GREEN:old"])).updated).toEqual(["Done", "Todo"])
    expect(replaceOptions(existing, parseOptions(["Todo:GREEN:old"]))).toMatchObject({ updated: [], changed: true })
  })
})
