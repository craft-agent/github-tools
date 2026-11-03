import { describe, expect, test } from "bun:test"
import { kindLabel, readKind } from "./kind"

describe("readKind", () => {
  test("the Issue Type's name, lower-cased, wins over a label", () => {
    expect(readKind("Bug", ["type:feature"])).toBe("bug")
  })

  test("else the suffix of the type: label, lower-cased", () => {
    expect(readKind(null, ["good first issue", "type:Feature"])).toBe("feature")
    expect(readKind(undefined, ["TYPE:docs"])).toBe("docs")
  })

  test("else null, also for an empty suffix or an empty type name", () => {
    expect(readKind(null, [])).toBeNull()
    expect(readKind(null, ["type:", "typed"])).toBeNull()
    expect(readKind("", ["bug"])).toBeNull()
  })
})

describe("kindLabel", () => {
  test("is type: and the kind in lower case", () => {
    expect(kindLabel("Bug")).toBe("type:bug")
  })
})
