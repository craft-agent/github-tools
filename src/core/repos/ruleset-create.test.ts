import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  rawRuleset,
  repositoryViewRule,
  restFailure,
  rulesetListRule,
  rulesetView,
  writeLog,
} from "../../testing/repos-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { rulesetCreate } from "./ruleset-create"

const { use, run } = writeHarness(rulesetCreate)
const posted = { match: "-X POST", stdout: JSON.stringify(rawRuleset()) }
const POST_ARGS = ["api", "-X", "POST", "repos/octo/hello/rulesets", "--input", "-"]
const RULES = [{ type: "deletion" }]

/** The view and context of `octo/hello`, the list of its rulesets, and the POST. */
const rules = (...existing: unknown[]) => [repositoryViewRule(), repositoryRule(), rulesetListRule(...existing), posted]

describe("the request", () => {
  test("a branch ruleset takes the defaults: the default branch, active, nobody bypassing", async () => {
    const installed = use(rules())
    expect(await run({ name: "Protect main", rules: RULES })).toEqual({
      repo: "octo/hello",
      ruleset: rulesetView(),
      foreign: false,
    })
    expect(writeLog(installed)).toEqual([
      {
        args: POST_ARGS,
        body: {
          name: "Protect main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
          rules: [{ type: "deletion" }],
          bypass_actors: [],
        },
      },
    ])
  })

  test("every argument is sent: a tag ruleset with parameters and bypass actors", async () => {
    const installed = use(rules())
    await run({
      repo: "octo/hello",
      name: "Release tags",
      target: "tag",
      enforcement: "evaluate",
      include: ["v*", "refs/tags/rel/*", "~ALL"],
      exclude: ["v0*"],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward", parameters: {} },
        { type: "tag_name_pattern", parameters: { operator: "regex", pattern: "^v" } },
      ],
      bypass: [
        { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "pull_request" },
        { actor_type: "DeployKey" },
        { actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "exempt" },
      ],
    })
    expect(writeLog(installed)[0]!.body).toEqual({
      name: "Release tags",
      target: "tag",
      enforcement: "evaluate",
      conditions: { ref_name: { include: ["refs/tags/v*", "refs/tags/rel/*", "~ALL"], exclude: ["refs/tags/v0*"] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward", parameters: {} },
        { type: "tag_name_pattern", parameters: { operator: "regex", pattern: "^v" } },
      ],
      bypass_actors: [
        { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
        { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
        { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "exempt" },
      ],
    })
  })

  test.each([
    ["branch", ["main", "release/*", "refs/heads/dev", "~DEFAULT_BRANCH", "~ALL", " feature "], "refs/heads/"],
    ["tag", ["v1", "refs/tags/v2", "refs/heads/odd", "~ALL"], "refs/tags/"],
  ])("%s patterns: refs/ kept, ~ names kept, a bare name or glob prefixed", async (target, include, prefix) => {
    const installed = use(rules())
    await run({ name: "N", target, include, exclude: ["tmp*"], rules: RULES })
    const sent = (
      writeLog(installed)[0]!.body as { conditions: { ref_name: { include: string[]; exclude: string[] } } }
    ).conditions.ref_name
    expect(sent.include).toEqual(
      include.map((pattern) =>
        pattern.trim().startsWith("refs/") || pattern.startsWith("~") ? pattern.trim() : `${prefix}${pattern.trim()}`,
      ),
    )
    expect(sent.exclude).toEqual([`${prefix}tmp*`])
  })

  test("a push ruleset sends no conditions", async () => {
    const installed = use(rules())
    await run({
      name: "Push rules",
      target: "push",
      rules: [{ type: "max_file_size", parameters: { max_file_size: 10 } }],
    })
    expect(writeLog(installed)[0]!.body).toEqual({
      name: "Push rules",
      target: "push",
      enforcement: "active",
      rules: [{ type: "max_file_size", parameters: { max_file_size: 10 } }],
      bypass_actors: [],
    })
  })

  test("an empty include takes the default for a branch", async () => {
    const installed = use(rules())
    await run({ name: "N", include: [], rules: RULES })
    expect(writeLog(installed)[0]!.body).toMatchObject({
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    })
  })

  test("a repository owned by someone else is foreign", async () => {
    use([repositoryViewRule(), repositoryRule({ viewer: "bob" }), rulesetListRule(), posted])
    expect((await run({ name: "N", rules: RULES })).foreign).toBe(true)
  })
})

describe("refusals, with nothing written", () => {
  test.each([
    ["include", { include: ["main"] }],
    ["exclude", { exclude: ["main"] }],
    ["an empty include", { include: [] }],
  ])("a push ruleset takes no %s", async (_, extra) => {
    const installed = use(rules())
    const error = await failure(run({ name: "N", target: "push", rules: RULES, ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("A push ruleset has no ref conditions")
    expect(sent(installed)).toEqual([])
  })

  test.each([{}, { include: [] }])("a tag ruleset needs include (%p)", async (extra) => {
    const installed = use(rules())
    const error = await failure(run({ name: "N", target: "tag", rules: RULES, ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('include is required for a tag ruleset: name the tags it covers, such as ["v*"].')
    expect(sent(installed)).toEqual([])
  })

  test("a blank pattern is refused", async () => {
    const installed = use(rules())
    const error = await failure(run({ name: "N", include: ["main", "  "], rules: RULES }))
    expect(error.message).toBe("include: a ref pattern cannot be blank.")
    expect(sent(installed)).toEqual([])
  })

  test.each([
    ["no rules", { rules: [] }],
    ["no rules argument", {}],
    ["a rule without a type", { rules: [{}] }],
    ["a blank name", { name: "  ", rules: RULES }],
    ["an unknown target", { target: "repository", rules: RULES }],
    ["an unknown enforcement", { enforcement: "on", rules: RULES }],
    ["an unknown actor type", { rules: RULES, bypass: [{ actor_type: "User" }] }],
    ["an unknown bypass mode", { rules: RULES, bypass: [{ actor_type: "Team", bypass_mode: "never" }] }],
  ])("%s is invalid_argument", async (_, extra) => {
    const installed = use(rules())
    expect((await failure(run({ name: "N", ...extra }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a name the repository's ruleset has is refused, without regard to case", async () => {
    const installed = use(rules(rawRuleset({ id: 3, name: "PROTECT main" })))
    const error = await failure(run({ name: "Protect Main", rules: RULES }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'octo/hello has a ruleset named "PROTECT main" already (id 3); change it with github_ruleset_edit, or pick another name.',
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("a ruleset inherited under that name does not block it", async () => {
    use(rules(rawRuleset({ id: 3, source_type: "Organization", source: "octo" })))
    expect((await run({ name: "Protect main", rules: RULES })).ruleset.id).toBe(7)
  })

  test("admin permission is required", async () => {
    const installed = use([repositoryViewRule({ viewerPermission: "MAINTAIN" }), rulesetListRule(), posted])
    expect((await failure(run({ name: "N", rules: RULES }))).code).toBe("forbidden")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("confirmation", () => {
  test("states the name, repository, enforcement, refs and rule types", async () => {
    use(rules())
    const requests: ConfirmRequest[] = []
    await invoke(
      rulesetCreate,
      {
        name: "Protect main",
        enforcement: "evaluate",
        include: ["main"],
        exclude: ["wip"],
        rules: [{ type: "deletion" }, { type: "pull_request", parameters: {} }],
      },
      {
        cwd: process.cwd(),
        confirm: async (request) => {
          requests.push(request)
          return true
        },
      },
    )
    expect(requests).toEqual([
      {
        tool: "github_ruleset_create",
        message:
          'Create the ruleset "Protect main" on octo/hello with enforcement evaluate? It covers refs/heads/main except refs/heads/wip and has the rules: deletion, pull_request.',
      },
    ])
  })

  test("a push ruleset is described by what it covers", async () => {
    use(rules())
    const requests: ConfirmRequest[] = []
    await invoke(
      rulesetCreate,
      { name: "Push rules", target: "push", rules: RULES },
      {
        cwd: process.cwd(),
        confirm: async (request) => {
          requests.push(request)
          return true
        },
      },
    )
    expect(requests[0]!.message).toBe(
      'Create the ruleset "Push rules" on octo/hello with enforcement active? It covers every push to the repository and has the rules: deletion.',
    )
  })

  test.each([true, false])("accepted=%p", async (accept) => {
    const installed = use(rules())
    const result = invoke(
      rulesetCreate,
      { name: "N", rules: RULES },
      { cwd: process.cwd(), confirm: async () => accept },
    )
    if (accept) expect((await result).ruleset.id).toBe(7)
    else expect((await failure(result)).code).toBe("declined")
    expect(writeLog(installed).length).toBe(accept ? 1 : 0)
  })
})

describe("GitHub's answer", () => {
  test("HTTP 422 is invalid_argument with GitHub's own words", async () => {
    use([
      repositoryViewRule(),
      repositoryRule(),
      rulesetListRule(),
      restFailure("-X POST", "Unprocessable Entity (HTTP 422)", {
        message: "Validation Failed",
        errors: ["Invalid rule 'bogus': "],
      }),
    ])
    const error = await failure(run({ name: "N", rules: [{ type: "bogus" }] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("GitHub refused it: Unprocessable Entity: Invalid rule 'bogus'.")
  })

  test("another failed write keeps its code", async () => {
    use([repositoryViewRule(), repositoryRule(), rulesetListRule(), restFailure("-X POST", "Forbidden (HTTP 403)")])
    expect((await failure(run({ name: "N", rules: RULES }))).code).toBe("forbidden")
  })

  test("a reply without a ruleset is an error", async () => {
    use([repositoryViewRule(), repositoryRule(), rulesetListRule(), { match: "-X POST" }])
    expect((await failure(run({ name: "N", rules: RULES }))).code).toBe("upstream_error")
  })
})
