import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { rawRuleset, repositoryViewRule, restFailure, rulesetGetRule, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { rulesetDelete } from "./ruleset-delete"

const { use, run } = writeHarness(rulesetDelete)
const DELETE_ARGS = ["api", "-X", "DELETE", "repos/octo/hello/rulesets/7"]
const UPDATED_AT = "2026-11-04T14:20:32.084+08:00"

/** The view and context of `octo/hello`, a DELETE (ahead of the read, whose pattern its path also fits), and ruleset 7 with `extra`. */
const rules = (extra: Record<string, unknown> = {}) => [
  repositoryViewRule(),
  repositoryRule(),
  { match: "-X DELETE" },
  rulesetGetRule(rawRuleset(extra)),
]

describe("the request", () => {
  test("DELETE names the ruleset and the result says what went", async () => {
    const installed = use(rules())
    expect(await run({ ruleset: 7 })).toEqual({
      repo: "octo/hello",
      deleted: { id: 7, name: "Protect main" },
      foreign: false,
    })
    expect(writeLog(installed)).toEqual([{ args: DELETE_ARGS, body: null }])
  })

  test("repo names another repository", async () => {
    const installed = use([
      repositoryViewRule({ nameWithOwner: "other/thing" }),
      repositoryRule({ repo: "other/thing", viewer: "bob" }),
      { match: "-X DELETE" },
      rulesetGetRule(rawRuleset({ source: "other/thing" })),
    ])
    const result = await run({ repo: "other/thing", ruleset: 7 })
    expect(result).toEqual({ repo: "other/thing", deleted: { id: 7, name: "Protect main" }, foreign: true })
    expect(writeLog(installed)[0]!.args).toEqual(["api", "-X", "DELETE", "repos/other/thing/rulesets/7"])
  })
})

describe("refusals, with nothing written", () => {
  test.each([
    ["a ruleset id of 0", { ruleset: 0 }],
    ["a ruleset id that is text", { ruleset: "7" }],
    ["no ruleset", {}],
    ["an updated_at that is no timestamp", { ruleset: 7, updated_at: "yesterday" }],
  ])("%s is invalid_argument", async (_, args) => {
    const installed = use(rules())
    expect((await failure(run(args))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a ruleset that does not exist is not_found", async () => {
    const installed = use([repositoryViewRule(), repositoryRule(), restFailure("rulesets/9$", "Not Found (HTTP 404)")])
    const error = await failure(run({ ruleset: 9 }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Ruleset 9 was not found in octo/hello, or the viewer cannot see it.")
    expect(writeLog(installed)).toEqual([])
  })

  test("an inherited ruleset is deleted where it is defined", async () => {
    const installed = use(rules({ source_type: "Organization", source: "octo" }))
    const error = await failure(run({ ruleset: 7 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'Ruleset 7 "Protect main" is inherited by octo/hello from organization octo; delete it where it is defined.',
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("admin permission is required", async () => {
    const installed = use([repositoryViewRule({ viewerPermission: "WRITE" }), ...rules()])
    expect((await failure(run({ ruleset: 7 }))).code).toBe("forbidden")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("updated_at", () => {
  test.each([UPDATED_AT, "2026-11-04T06:20:32.084Z"])(
    "%s is the current instant, so the delete goes through",
    async (at) => {
      const installed = use(rules())
      await run({ ruleset: 7, updated_at: at })
      expect(writeLog(installed).length).toBe(1)
    },
  )

  test("another instant is stale, and nothing is deleted", async () => {
    const installed = use(rules())
    const error = await failure(run({ ruleset: 7, updated_at: "2026-11-05T06:20:32.084Z" }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      "Ruleset 7 of octo/hello was last changed at 2026-11-04T14:20:32.084+08:00, not 2026-11-05T06:20:32.084Z: it changed since it was read. Nothing was written; read it again with github_ruleset_read.",
    )
    expect(writeLog(installed)).toEqual([])
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

  test("says it cannot be undone and offers disabling", async () => {
    use(rules())
    const requests: ConfirmRequest[] = []
    await invoke(rulesetDelete, { ruleset: 7 }, confirming(true, requests))
    expect(requests).toEqual([
      {
        tool: "github_ruleset_delete",
        message:
          'Delete the ruleset "Protect main" (id 7) from octo/hello? This cannot be undone; to keep it without enforcing it, set its enforcement to "disabled" with github_ruleset_edit instead.',
      },
    ])
  })

  test("declined deletes nothing", async () => {
    const installed = use(rules())
    expect((await failure(invoke(rulesetDelete, { ruleset: 7 }, confirming(false)))).code).toBe("declined")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("GitHub's answer", () => {
  test("HTTP 422 is invalid_argument with GitHub's own words", async () => {
    use([
      repositoryViewRule(),
      repositoryRule(),
      restFailure("-X DELETE", "Unprocessable Entity (HTTP 422)", { errors: ["Cannot delete this ruleset"] }),
      rulesetGetRule(rawRuleset()),
    ])
    const error = await failure(run({ ruleset: 7 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("GitHub refused it: Unprocessable Entity: Cannot delete this ruleset.")
  })

  test("a ruleset deleted meanwhile is not_found", async () => {
    use([
      repositoryViewRule(),
      repositoryRule(),
      restFailure("-X DELETE", "Not Found (HTTP 404)"),
      rulesetGetRule(rawRuleset()),
    ])
    expect((await failure(run({ ruleset: 7 }))).code).toBe("not_found")
  })
})
