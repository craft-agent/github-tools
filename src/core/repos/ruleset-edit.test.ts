import { describe, expect, test } from "bun:test"
import {
  rawRuleset,
  repositoryViewRule,
  rulesetGetRule,
  rulesetListRule,
  rulesetView,
  writeLog,
} from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { rulesetEdit } from "./ruleset-edit"

const { use, run } = writeHarness(rulesetEdit)
const PUT_ARGS = ["api", "-X", "PUT", "repos/octo/hello/rulesets/7", "--input", "-"]

/** The view and context of `octo/hello`, ruleset 7 (with `extra`), a list of its rulesets, and a PUT that answers `after`. */
const rules = (extra: Record<string, unknown> = {}, after: Record<string, unknown> = {}, ...others: unknown[]) => [
  repositoryViewRule(),
  repositoryRule(),
  { match: "-X PUT", stdout: JSON.stringify(rawRuleset({ ...extra, ...after })) },
  rulesetListRule(rawRuleset(extra), ...others),
  rulesetGetRule(rawRuleset(extra)),
]

describe("the request", () => {
  test("only the parts that differ are sent, and the ruleset is the one GitHub answers with", async () => {
    const installed = use(rules({}, { name: "Guard main", enforcement: "disabled" }))
    expect(await run({ ruleset: 7, name: "Guard main", enforcement: "disabled" })).toEqual({
      repo: "octo/hello",
      ruleset: rulesetView({ name: "Guard main", enforcement: "disabled" }),
      changed: ["name", "enforcement"],
      foreign: false,
    })
    expect(writeLog(installed)).toEqual([{ args: PUT_ARGS, body: { name: "Guard main", enforcement: "disabled" } }])
  })

  test("a part equal to the current one is not sent", async () => {
    const installed = use(rules())
    const result = await run({ ruleset: 7, name: "Protect main", enforcement: "evaluate" })
    expect(result.changed).toEqual(["enforcement"])
    expect(writeLog(installed)[0]!.body).toEqual({ enforcement: "evaluate" })
  })

  test("include replaces its list, normalised, and exclude keeps its value and other conditions", async () => {
    const conditions = { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/wip"] }, other: { keep: 1 } }
    const installed = use(rules({ conditions }))
    expect((await run({ ruleset: 7, include: ["dev", "~DEFAULT_BRANCH", "refs/heads/rel/*"] })).changed).toEqual([
      "include",
    ])
    expect(writeLog(installed)[0]!.body).toEqual({
      conditions: {
        ref_name: { include: ["refs/heads/dev", "~DEFAULT_BRANCH", "refs/heads/rel/*"], exclude: ["refs/heads/wip"] },
        other: { keep: 1 },
      },
    })
  })

  test("exclude replaces its list and include keeps its value", async () => {
    const installed = use(rules())
    expect((await run({ ruleset: 7, exclude: ["tmp*"] })).changed).toEqual(["exclude"])
    expect(writeLog(installed)[0]!.body).toEqual({
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/tmp*"] } },
    })
  })

  test("include and exclude of a tag ruleset get the tag prefix", async () => {
    const installed = use(rules({ target: "tag", conditions: { ref_name: { include: ["~ALL"], exclude: [] } } }))
    expect((await run({ ruleset: 7, include: ["v*"], exclude: ["v0*"] })).changed).toEqual(["include", "exclude"])
    expect(writeLog(installed)[0]!.body).toEqual({
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0*"] } },
    })
  })

  test("a ruleset without ref conditions has empty lists to replace", async () => {
    const installed = use(rules({ conditions: null }))
    expect((await run({ ruleset: 7, include: ["main"] })).changed).toEqual(["include"])
    expect(writeLog(installed)[0]!.body).toEqual({
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    })
  })

  test("rules and bypass replace their whole lists", async () => {
    const installed = use(rules())
    expect(
      (
        await run({
          ruleset: 7,
          rules: [{ type: "deletion" }, { type: "required_signatures", parameters: {} }],
          bypass: [{ actor_type: "Team", actor_id: 9 }, { actor_type: "DeployKey" }],
        })
      ).changed,
    ).toEqual(["rules", "bypass"])
    expect(writeLog(installed)[0]!.body).toEqual({
      rules: [{ type: "deletion" }, { type: "required_signatures", parameters: {} }],
      bypass_actors: [
        { actor_id: 9, actor_type: "Team", bypass_mode: "always" },
        { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
      ],
    })
  })

  test("an empty bypass list removes the bypass actors", async () => {
    const installed = use(rules())
    expect((await run({ ruleset: 7, bypass: [] })).changed).toEqual(["bypass"])
    expect(writeLog(installed)[0]!.body).toEqual({ bypass_actors: [] })
  })

  test("a rule's parameters differing in a value are a change", async () => {
    const installed = use(rules())
    const result = await run({
      ruleset: 7,
      rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 2 } }],
    })
    expect(result.changed).toEqual(["rules"])
    expect(writeLog(installed).length).toBe(1)
  })

  test("a ruleset whose bypass actors GitHub does not show takes a bypass list as a change", async () => {
    use(rules({ bypass_actors: undefined }))
    expect((await run({ ruleset: 7, bypass: [] })).changed).toEqual(["bypass"])
  })
})

describe("nothing to change", () => {
  test("the same values, however they are spelled, write and confirm nothing", async () => {
    const installed = use(
      rules({ bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] }),
    )
    const confirmed: ConfirmRequest[] = []
    const result = await invoke(
      rulesetEdit,
      {
        ruleset: 7,
        name: "Protect main",
        enforcement: "active",
        include: ["main"],
        exclude: [],
        rules: [
          { type: "pull_request", parameters: { required_approving_review_count: 1 } },
          { type: "deletion" },
        ].reverse(),
        bypass: [{ actor_type: "RepositoryRole", actor_id: 5 }],
      },
      {
        cwd: process.cwd(),
        confirm: async (request) => {
          confirmed.push(request)
          return true
        },
      },
    )
    expect(result).toEqual({
      repo: "octo/hello",
      ruleset: rulesetView({
        bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      }),
      changed: [],
      foreign: false,
    })
    expect(writeLog(installed)).toEqual([])
    expect(confirmed).toEqual([])
  })

  test("rule parameters with their keys in another order are the same", async () => {
    const parameters = { a: 1, b: { c: 2, d: [3] } }
    const installed = use(rules({ rules: [{ type: "x", parameters }] }))
    const result = await run({ ruleset: 7, rules: [{ type: "x", parameters: { b: { d: [3], c: 2 }, a: 1 } }] })
    expect(result.changed).toEqual([])
    expect(writeLog(installed)).toEqual([])
  })
})
