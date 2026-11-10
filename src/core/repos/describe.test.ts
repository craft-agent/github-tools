import { describe, expect, test } from "bun:test"
import {
  rawRuleset,
  repositoryFactsRule,
  repositoryOwnerRule,
  restFailure,
  rulesetListRule,
} from "../../testing/repos-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { NOTHING_CHANGED, NOT_ARCHIVED } from "../write-facts"
import {
  DESCRIBE_CASES,
  branchRule,
  createRules,
  describeCase,
  repoRules,
  type DescribeCase,
} from "./describe.fixtures"

/** The methods of a `gh api` call that change something. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

const named = (text: string, name = "octo/hello") => ({ text, values: { name } })
const visibility = (word: string) => ({ label: "Visibility", value: { text: word } })

describe("github_repo_archive", () => {
  const headline = named("About to archive the repository {name}")

  test("names the repository as GitHub spells it and shows the visibility it keeps", async () => {
    expect(await describeCase(DESCRIBE_CASES.archive)).toEqual({ headline, facts: [visibility("Public")] })
  })

  test("a repository named by owner/name is the same", async () => {
    expect(await describeCase(DESCRIBE_CASES.archivePrivate)).toEqual({ headline, facts: [visibility("Private")] })
  })

  test("an internal repository shows Internal", async () => {
    expect((await describeCase(DESCRIBE_CASES.archiveInternal))?.facts).toEqual([visibility("Internal")])
  })

  test.each([
    ["a repository that is archived already", DESCRIBE_CASES.archive.args, repoRules({ isArchived: true })],
    [
      "a repository the viewer does not administer",
      DESCRIBE_CASES.archive.args,
      repoRules({ viewerPermission: "WRITE" }),
    ],
    [
      "a repository that does not exist",
      DESCRIBE_CASES.archive.args,
      [{ match: "homepageUrl", stderr: "HTTP 404", code: 1 }],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.archive, args, rules })).toBeUndefined()
  })
})

describe("github_repo_unarchive", () => {
  const headline = named("About to unarchive the repository {name}")

  test("names the repository and shows the visibility it keeps", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchive)).toEqual({ headline, facts: [visibility("Public")] })
  })

  test("a repository that is not archived says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchiveActive)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOT_ARCHIVED } }],
    })
  })

  test("a repository the viewer does not administer gives no description", async () => {
    const rules = repoRules({ isArchived: true, viewerPermission: "WRITE" })
    expect(await describeCase({ ...DESCRIBE_CASES.unarchive, rules })).toBeUndefined()
  })
})

describe("github_repo_visibility", () => {
  test.each([
    ["publicToPrivate", "About to make the repository {name} private", "Public to private"],
    ["publicToInternal", "About to make the repository {name} internal", "Public to internal"],
    ["privateToPublic", "About to make the repository {name} public", "Private to public"],
    ["privateToInternal", "About to make the repository {name} internal", "Private to internal"],
    ["internalToPublic", "About to make the repository {name} public", "Internal to public"],
    ["internalToPrivate", "About to make the repository {name} private", "Internal to private"],
  ] as const)("%s: a headline by the visibility asked for and the transition", async (key, text, transition) => {
    expect(await describeCase(DESCRIBE_CASES[key])).toEqual({ headline: named(text), facts: [visibility(transition)] })
  })

  const change = DESCRIBE_CASES.privateToPublic
  test.each([
    ["the visibility it has already", { visibility: "public" }, repoRules()],
    [
      "internal for a user's repository",
      { visibility: "internal" },
      repoRules({ owner: { __typename: "User", login: "octo" }, visibility: "PRIVATE" }),
    ],
    [
      "a repository the viewer does not administer",
      change.args,
      repoRules({ visibility: "PRIVATE", viewerPermission: "MAINTAIN" }),
    ],
    ["an unknown visibility", { visibility: "secret" }, change.rules],
    ["no visibility", {}, change.rules],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...change, args, rules })).toBeUndefined()
  })
})

describe("github_repo_create", () => {
  const headline = named("About to create the repository {name}", "octo/new")

  test("a repository is private by default, and the headline names it", async () => {
    expect(await describeCase(DESCRIBE_CASES.createPrivate)).toEqual({ headline, facts: [visibility("Private")] })
  })

  test("a public repository shows Public first", async () => {
    expect(await describeCase(DESCRIBE_CASES.createPublic)).toEqual({ headline, facts: [visibility("Public")] })
  })

  test("an internal repository shows the description verbatim, trimmed as it is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.createInternal)).toEqual({
      headline,
      facts: [visibility("Internal")],
      text: { label: "Description", body: "Internal tool" },
    })
  })

  test("a template is shown as owner/name", async () => {
    expect(await describeCase(DESCRIBE_CASES.createFromTemplate)).toEqual({
      headline,
      facts: [visibility("Private"), { label: "Template", value: "octo/hello-template" }],
      text: { label: "Description", body: "From a template" },
    })
  })

  test("every optional piece is a fact, and the owner is the login GitHub knows", async () => {
    expect(await describeCase(DESCRIBE_CASES.createWithEverything)).toEqual({
      headline: named("About to create the repository {name}", "alice/new"),
      facts: [
        visibility("Public"),
        { label: "License", value: "mit" },
        { label: "Gitignore", value: "Node" },
        { label: "README", value: { text: "Added" } },
        { label: "Homepage", value: "https://tool.example" },
      ],
      text: { label: "Description", body: "A tool" },
    })
  })

  const create = DESCRIBE_CASES.createPrivate
  const template = DESCRIBE_CASES.createFromTemplate
  test.each([
    ["a bad repository name", { repo: "new" }, create.rules],
    ["an unknown visibility", { repo: "octo/new", visibility: "secret" }, create.rules],
    [
      "a repository that exists already",
      create.args,
      [repositoryOwnerRule("octo", { type: "Organization" }), repositoryFactsRule("octo/new", { isTemplate: false })],
    ],
    ["another user's account", { repo: "bob/new" }, createRules("bob/new", { type: "User" })],
    ["an owner that does not exist", { repo: "ghost/new" }, [repositoryOwnerRule("ghost", { type: null })]],
    [
      "internal for the viewer's own repository",
      { repo: "alice/new", visibility: "internal" },
      createRules("alice/new", { viewer: "Alice", type: "User" }),
    ],
    ["a template with a license", { ...template.args, license: "mit" }, template.rules],
    ["a template with a homepage", { ...template.args, homepage: "https://x.example" }, template.rules],
    ["an internal repository from a template", { ...template.args, visibility: "internal" }, template.rules],
    [
      "a template that does not exist",
      template.args,
      [...createRules("octo/new"), repositoryFactsRule("octo/hello-template", null)],
    ],
    [
      "a repository that is not a template",
      template.args,
      [...createRules("octo/new"), repositoryFactsRule("octo/hello-template", { isTemplate: false })],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...create, args, rules })).toBeUndefined()
  })
})

describe("github_repo_edit", () => {
  const headline = named("About to edit the settings of the repository {name}")

  test("shows only what changes, most decisive first, with the new description as text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editEverything)).toEqual({
      headline,
      facts: [
        { label: "Default branch", value: "dev" },
        { label: "Topics", value: "+rust \u2212cli" },
        { label: "Features", value: "+wiki \u2212issues" },
        { label: "Merge methods", value: "+rebase \u2212squash" },
        { label: "Merge options", value: "+update_branch \u2212auto_merge" },
        { label: "Template repository", value: { text: "On" } },
        { label: "Homepage", value: { text: "Cleared" } },
      ],
      text: { label: "Description", body: "A new description" },
    })
  })

  test("a new homepage is shown as it is", async () => {
    expect(await describeCase(DESCRIBE_CASES.editHomepage)).toEqual({
      headline,
      facts: [{ label: "Homepage", value: "https://new.example" }],
    })
  })

  test("a cleared description is a fact, not text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editClearDescription)).toEqual({
      headline,
      facts: [{ label: "Description", value: { text: "Cleared" } }],
    })
  })

  test("a repository that stops being a template shows Off", async () => {
    expect((await describeCase(DESCRIBE_CASES.editTemplateOff))?.facts).toEqual([
      { label: "Template repository", value: { text: "Off" } },
    ])
  })

  test("what is in place already says nothing is sent, with no text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editNothing)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOTHING_CHANGED } }],
    })
  })

  const edit = DESCRIBE_CASES.editEverything
  test.each([
    ["no setting at all", {}, edit.rules],
    ["an archived repository", edit.args, [...repoRules({ isArchived: true }), branchRule("dev")]],
    [
      "a repository the viewer does not administer",
      edit.args,
      [...repoRules({ viewerPermission: "WRITE" }), branchRule("dev")],
    ],
    [
      "a default branch that does not exist",
      { default_branch: "nope" },
      [restFailure("branches/nope", "Not Found (HTTP 404)"), ...repoRules()],
    ],
    ["a topic that is not one", { add_topics: ["Not A Topic"] }, edit.rules],
    ["a topic in both lists", { add_topics: ["x"], remove_topics: ["x"] }, edit.rules],
    ["every merge method off", { allow_merge_commit: false, allow_squash_merge: false }, edit.rules],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...edit, args, rules })).toBeUndefined()
  })
})

describe("github_ruleset_create", () => {
  const headline = named("About to create the ruleset {name}", "Guard")
  const enforcement = (word: string) => ({ label: "Enforcement", value: { text: word } })
  const target = (word: string) => ({ label: "Target", value: { text: word } })

  test("the defaults are an active branch ruleset on the default branch", async () => {
    expect(await describeCase(DESCRIBE_CASES.createRulesetDefaults)).toEqual({
      headline,
      facts: [
        enforcement("Active"),
        target("Branch"),
        { label: "Refs", value: "+~DEFAULT_BRANCH" },
        { label: "Rules", value: "deletion" },
      ],
    })
  })

  test("every piece is a fact, with the patterns as the call writes them", async () => {
    expect(await describeCase(DESCRIBE_CASES.createRulesetFull)).toEqual({
      headline,
      facts: [
        enforcement("Evaluate"),
        target("Branch"),
        { label: "Refs", value: "+refs/heads/main +refs/heads/release/* \u2212refs/heads/tmp" },
        { label: "Rules", value: "deletion, pull_request" },
        { label: "Bypass", value: { text: "{count} actors", values: { count: 2 } } },
      ],
    })
  })

  test("a tag ruleset with one bypass actor", async () => {
    expect((await describeCase(DESCRIBE_CASES.createRulesetTag))?.facts).toEqual([
      enforcement("Active"),
      target("Tag"),
      { label: "Refs", value: "+refs/tags/v*" },
      { label: "Rules", value: "update" },
      { label: "Bypass", value: { text: "{count} actor", values: { count: 1 } } },
    ])
  })

  test("a push ruleset has no refs and may be disabled", async () => {
    expect((await describeCase(DESCRIBE_CASES.createRulesetPush))?.facts).toEqual([
      enforcement("Disabled"),
      target("Push"),
      { label: "Rules", value: "file_path_restriction" },
    ])
  })

  const create = DESCRIBE_CASES.createRulesetDefaults
  test.each([
    ["a tag ruleset without include", { ...create.args, target: "tag" }, create.rules],
    ["include on a push ruleset", { ...create.args, target: "push", include: ["main"] }, create.rules],
    ["exclude on a push ruleset", { ...create.args, target: "push", exclude: ["main"] }, create.rules],
    ["a blank ref pattern", { ...create.args, include: [" "] }, create.rules],
    [
      "a name another ruleset has, in any case",
      { ...create.args, name: "protect MAIN" },
      [...repoRules(), rulesetListRule(rawRuleset())],
    ],
    ["no rules", { name: "Guard", rules: [] }, create.rules],
    [
      "a repository the viewer does not administer",
      create.args,
      [...repoRules({ viewerPermission: "WRITE" }), rulesetListRule()],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...create, args, rules })).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values<DescribeCase>(DESCRIBE_CASES)

  test.each(cases.map((item) => [item.name, item] as const))("%s: is within the budgets", async (_name, item) => {
    const description = await describeCase(item)
    expect(description).toBeDefined()
    expect(Array.from(description!.headline!.text).length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH)
    expect(description!.facts.length).toBeLessThanOrEqual(MAX_FACTS)
    for (const { label } of description!.facts) expect(Array.from(label).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
  })

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: is the same when asked twice",
    async (_name, item) => {
      expect(await describeCase(item)).toEqual(await describeCase(item))
    },
  )

  test.each(cases.map((item) => [item.name, item] as const))("%s: only reads", async (_name, item) => {
    let calls: string[][] = []
    await describeCase(item, (seen) => (calls = seen))
    const isWrite = (args: string[]) =>
      queryOf(args).startsWith("mutation") || WRITE_METHODS.some((method) => args.includes(method))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(isWrite)).toEqual([])
  })
})
