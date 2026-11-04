import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { ISSUE_TYPES, commands, issueTypesRule, labelRule, noIssueTypesRule, sent } from "../../testing/write-fixtures"
import { ToolError } from "../errors"
import { parseRepo } from "../refs"
import { resetIssueTypeCache } from "./repository"
import {
  ensureLabel,
  isTypeFailure,
  kindFlags,
  kindLabel,
  otherKindLabels,
  readKind,
  resolveKind,
  withKindFallback,
} from "./kind"

const CTX = { cwd: process.cwd() }
const REPO = parseRepo("octo/hello")

let fake: FakeGh | undefined

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

beforeEach(resetIssueTypeCache)

afterEach(() => {
  fake?.restore()
  fake = undefined
})

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

describe("resolveKind", () => {
  test("is the Issue Type of that name, in GitHub's spelling, matched without regard to case", async () => {
    useFake([issueTypesRule("Bug", "Feature")])
    expect(await resolveKind(" bUG ", REPO, CTX)).toEqual({ via: "type", name: "Bug" })
  })

  test("is the type:<kind> label when the owner has no such type", async () => {
    useFake([issueTypesRule("Bug")])
    expect(await resolveKind("Chore", REPO, CTX)).toEqual({ via: "label", name: "type:chore" })
  })

  test("is the label for an owner without Issue Types", async () => {
    useFake([noIssueTypesRule()])
    expect(await resolveKind("bug", REPO, CTX)).toEqual({ via: "label", name: "type:bug" })
  })

  test("refuses an empty kind before asking GitHub", async () => {
    const installed = useFake([issueTypesRule("Bug")])
    for (const kind of ["", "  "]) {
      expect((await failure(resolveKind(kind, REPO, CTX))).code).toBe("invalid_argument")
    }
    expect(installed.calls().filter((args) => args[0] === "api")).toHaveLength(0)
  })

  test("a failed Issue Types read is the call's failure, not a label", async () => {
    useFake([{ match: ISSUE_TYPES, stderr: "HTTP 502", code: 1 }])
    expect((await failure(resolveKind("bug", REPO, CTX))).code).toBe("github_error")
  })
})

describe("ensureLabel", () => {
  test("leaves a label that exists alone", async () => {
    const installed = useFake([labelRule(true)])
    expect(await ensureLabel(REPO, "type:bug", CTX)).toBe(false)
    expect(commands(installed)).toEqual([])
  })

  test("creates a missing label without a color or --force", async () => {
    const installed = useFake([labelRule(false), { match: "^label create" }])
    expect(await ensureLabel(REPO, "type:bug", CTX)).toBe(true)
    expect(commands(installed).map((call) => call.args)).toEqual([
      ["label", "create", "type:bug", "--repo", "octo/hello"],
    ])
    const read = installed.calls().find((args) => args[0] === "api")!
    expect(read).toContain("label=type:bug")
  })

  test("a label another call created in between counts as existing", async () => {
    useFake([labelRule(false), { match: "^label create", stderr: "HTTP 422: already_exists", code: 1 }])
    expect(await ensureLabel(REPO, "type:bug", CTX)).toBe(false)
  })

  test("any other failure to create is thrown", async () => {
    useFake([labelRule(false), { match: "^label create", stderr: "HTTP 403: Resource not accessible", code: 1 }])
    expect((await failure(ensureLabel(REPO, "type:bug", CTX))).code).toBe("forbidden")
  })
})

describe("isTypeFailure", () => {
  test.each([
    ["github_error", "gh failed (exit 1): Issue type 'Bug' not found"],
    ["forbidden", "gh failed (exit 1): HTTP 403: cannot set the type of this issue"],
  ] as const)("a %s that mentions the type is one", (code, message) => {
    expect(isTypeFailure(new ToolError(code, message))).toBe(true)
  })

  test("anything else is not one", () => {
    expect(isTypeFailure(new ToolError("github_error", "gh failed (exit 1): could not add label"))).toBe(false)
    expect(isTypeFailure(new ToolError("not_found", "the issue type was not found"))).toBe(false)
    expect(isTypeFailure(new ToolError("github_error", "a prototype failed"))).toBe(false)
    expect(isTypeFailure(new Error("issue type"))).toBe(false)
  })
})

describe("withKindFallback", () => {
  const typeFailure = new ToolError("github_error", "gh failed (exit 1): issue type is not enabled")

  test("returns what the first attempt did", async () => {
    const seen: string[] = []
    const done = await withKindFallback("bug", { via: "type", name: "Bug" }, async (where) => seen.push(where.name))
    expect(done).toEqual({ placement: { via: "type", name: "Bug" }, result: 1 })
    expect(seen).toEqual(["Bug"])
  })

  test("tries the label once when the type fails", async () => {
    const seen: string[] = []
    const done = await withKindFallback("Bug", { via: "type", name: "Bug" }, async (where) => {
      seen.push(where.name)
      if (where.via === "type") throw typeFailure
      return "ok"
    })
    expect(done).toEqual({ placement: { via: "label", name: "type:bug" }, result: "ok" })
    expect(seen).toEqual(["Bug", "type:bug"])
  })

  test("rethrows a failure that is not about the type, and a failing label", async () => {
    const other = new ToolError("github_error", "gh failed (exit 1): boom")
    expect(await failure(withKindFallback("bug", { via: "type", name: "Bug" }, () => Promise.reject(other)))).toBe(
      other,
    )
    expect(
      await failure(withKindFallback("bug", { via: "label", name: "type:bug" }, () => Promise.reject(typeFailure))),
    ).toBe(typeFailure)
  })
})

describe("kindFlags", () => {
  test("a type is set by name", async () => {
    const installed = useFake([])
    expect(await kindFlags({ via: "type", name: "Bug" }, REPO, CTX)).toEqual(["--type", "Bug"])
    expect(sent(installed)).toEqual([])
  })

  test("a label is ensured and then added", async () => {
    const installed = useFake([labelRule(false), { match: "^label create" }])
    expect(await kindFlags({ via: "label", name: "type:bug" }, REPO, CTX)).toEqual(["--add-label", "type:bug"])
    expect(commands(installed)).toHaveLength(1)
  })
})

describe("otherKindLabels", () => {
  test("are the type: labels but the one to keep, without regard to case", () => {
    expect(otherKindLabels(["bug", "type:feature", "TYPE:Docs", "Type:Bug"], "type:bug")).toEqual([
      "type:feature",
      "TYPE:Docs",
    ])
  })
})
