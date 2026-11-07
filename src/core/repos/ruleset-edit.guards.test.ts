import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  rawRuleset,
  repositoryViewRule,
  restFailure,
  rulesetGetRule,
  rulesetListRule,
  writeLog,
} from "../../testing/repos-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { rulesetEdit } from "./ruleset-edit"

const { use, run } = writeHarness(rulesetEdit)
const UPDATED_AT = "2026-11-04T14:20:32.084+08:00"

/** The view and context of `octo/hello`, ruleset 7 (with `extra`), a list of its rulesets, and a PUT that answers `after`. */
const rules = (extra: Record<string, unknown> = {}, after: Record<string, unknown> = {}, ...others: unknown[]) => [
  repositoryViewRule(),
  repositoryRule(),
  { match: "-X PUT", stdout: JSON.stringify(rawRuleset({ ...extra, ...after })) },
  rulesetListRule(rawRuleset(extra), ...others),
  rulesetGetRule(rawRuleset(extra)),
]

describe("refusals, with nothing written", () => {
  test.each([[{}], [{ updated_at: UPDATED_AT }], [{ repo: "octo/hello" }]])("no part to change (%p)", async (extra) => {
    const installed = use(rules())
    const error = await failure(run({ ruleset: 7, ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "Pass at least one of name, enforcement, include, exclude, rules, bypass to change the ruleset.",
    )
    expect(sent(installed)).toEqual([])
  })

  test.each([
    ["a blank name", { name: " " }],
    ["an unknown enforcement", { enforcement: "on" }],
    ["a ruleset id of 0", { ruleset: 0, name: "x" }],
    ["a ruleset id that is text", { ruleset: "7", name: "x" }],
    ["an updated_at that is no timestamp", { updated_at: "yesterday", name: "x" }],
  ])("%s is invalid_argument", async (_, extra) => {
    const installed = use(rules())
    expect((await failure(run({ ruleset: 7, ...extra }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a ruleset that does not exist is not_found", async () => {
    const installed = use([repositoryViewRule(), repositoryRule(), restFailure("rulesets/9$", "Not Found (HTTP 404)")])
    const error = await failure(run({ ruleset: 9, name: "x" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Ruleset 9 was not found in octo/hello, or the viewer cannot see it.")
    expect(writeLog(installed)).toEqual([])
  })

  test("an inherited ruleset is edited where it is defined", async () => {
    const installed = use(rules({ source_type: "Organization", source: "octo" }))
    const error = await failure(run({ ruleset: 7, name: "x" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'Ruleset 7 "Protect main" is inherited by octo/hello from organization octo; edit it where it is defined.',
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("a name another ruleset has is refused, without regard to case", async () => {
    const installed = use(rules({}, {}, rawRuleset({ id: 8, name: "Release GUARD" })))
    const error = await failure(run({ ruleset: 7, name: "release guard" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'octo/hello has another ruleset named "Release GUARD" already (id 8); pick another name.',
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("a ruleset may change the case of its own name", async () => {
    const installed = use(rules())
    expect((await run({ ruleset: 7, name: "PROTECT MAIN" })).changed).toEqual(["name"])
    expect(writeLog(installed)[0]!.body).toEqual({ name: "PROTECT MAIN" })
  })

  test.each([
    ["include", { include: ["main"] }],
    ["exclude", { exclude: ["main"] }],
  ])("a push ruleset takes no %s", async (_, extra) => {
    const installed = use(rules({ target: "push", conditions: null }))
    const error = await failure(run({ ruleset: 7, ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("A push ruleset has no ref conditions")
    expect(writeLog(installed)).toEqual([])
  })

  test("admin permission is required", async () => {
    const installed = use([repositoryViewRule({ viewerPermission: "WRITE" }), ...rules()])
    expect((await failure(run({ ruleset: 7, name: "x" }))).code).toBe("forbidden")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("updated_at", () => {
  test("the current value lets the write through", async () => {
    const installed = use(rules())
    await run({ ruleset: 7, updated_at: UPDATED_AT, enforcement: "disabled" })
    expect(writeLog(installed).length).toBe(1)
  })

  test("the same instant in another zone format is not stale", async () => {
    const installed = use(rules())
    await run({ ruleset: 7, updated_at: "2026-11-04T06:20:32.084Z", enforcement: "disabled" })
    expect(writeLog(installed).length).toBe(1)
  })

  test("another instant is stale, and nothing is written", async () => {
    const installed = use(rules())
    const error = await failure(run({ ruleset: 7, updated_at: "2026-11-04T06:20:32.085Z", enforcement: "disabled" }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      "Ruleset 7 of octo/hello was last changed at 2026-11-04T14:20:32.084+08:00, not 2026-11-04T06:20:32.085Z: it changed since it was read. Nothing was written; read it again with github_ruleset_read.",
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("a ruleset that shows no updated_at is stale against one", async () => {
    use(rules({ updated_at: undefined }))
    expect((await failure(run({ ruleset: 7, updated_at: UPDATED_AT, enforcement: "disabled" }))).code).toBe("stale")
  })

  test("stale wins over nothing to change", async () => {
    use(rules())
    expect((await failure(run({ ruleset: 7, updated_at: "2026-01-01T00:00:00Z", name: "Protect main" }))).code).toBe(
      "stale",
    )
  })
})

describe("confirmation", () => {
  const confirming = (accept: boolean, requests: ConfirmRequest[] = []) => ({
    cwd: process.cwd(),
    confirm: async (request: ConfirmRequest) => {
      requests.push(request)
      return accept
    },
  })

  test("names the ruleset and the parts that change", async () => {
    use(rules())
    const requests: ConfirmRequest[] = []
    await invoke(
      rulesetEdit,
      {
        ruleset: 7,
        name: "Guard main",
        enforcement: "disabled",
        include: ["dev"],
        exclude: [],
        rules: [{ type: "deletion" }],
        bypass: [],
      },
      confirming(true, requests),
    )
    expect(requests).toEqual([
      {
        tool: "github_ruleset_edit",
        message:
          'Change the ruleset "Protect main" (id 7) of octo/hello? It changes: name to "Guard main"; enforcement from active to disabled; include to refs/heads/dev; rules to deletion; bypass actors to 0.',
      },
    ])
  })

  test("declined writes nothing", async () => {
    const installed = use(rules())
    const error = await failure(invoke(rulesetEdit, { ruleset: 7, enforcement: "disabled" }, confirming(false)))
    expect(error.code).toBe("declined")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("GitHub's answer", () => {
  test("HTTP 422 is invalid_argument with GitHub's own words", async () => {
    use([
      repositoryViewRule(),
      repositoryRule(),
      rulesetGetRule(rawRuleset()),
      restFailure("-X PUT", "Unprocessable Entity (HTTP 422)", {
        message: "Validation Failed",
        errors: ["Invalid rule 'bogus': "],
      }),
    ])
    const error = await failure(run({ ruleset: 7, rules: [{ type: "bogus" }] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("GitHub refused it: Unprocessable Entity: Invalid rule 'bogus'.")
  })

  test("a ruleset deleted meanwhile is not_found", async () => {
    use([
      repositoryViewRule(),
      repositoryRule(),
      rulesetGetRule(rawRuleset()),
      restFailure("-X PUT", "Not Found (HTTP 404)"),
    ])
    expect((await failure(run({ ruleset: 7, enforcement: "disabled" }))).code).toBe("not_found")
  })

  test("a foreign repository is reported", async () => {
    use([
      repositoryViewRule(),
      repositoryRule({ viewer: "bob" }),
      rulesetGetRule(rawRuleset()),
      { match: "-X PUT", stdout: JSON.stringify(rawRuleset()) },
    ])
    expect((await run({ ruleset: 7, enforcement: "disabled" })).foreign).toBe(true)
  })
})
