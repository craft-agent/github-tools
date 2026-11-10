import { describe, expect, test } from "bun:test"
import {
  LABEL_ROW,
  MILESTONE_ROW,
  labelPages,
  milestonePages,
  rawRuleset,
  repositoryFactsRule,
  repositoryOwnerRule,
  restFailure,
  rulesetListRule,
} from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { NOTHING_CHANGED, NOT_ARCHIVED } from "../write-facts"
import {
  DESCRIBE_CASES,
  RULESET_UPDATED_AT,
  branchRule,
  createRules,
  describeCase,
  labelRules,
  milestoneRules,
  repoRules,
  rulesetRules,
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

describe("github_ruleset_edit", () => {
  const headline = named("About to edit the ruleset {name}", "Protect main")
  const pins = { updated_at: RULESET_UPDATED_AT }

  test("shows each part that changes, with the real name in the headline and the update pinned", async () => {
    expect(await describeCase(DESCRIBE_CASES.editRulesetEverything)).toEqual({
      headline,
      facts: [
        { label: "Name", value: "Renamed" },
        { label: "Enforcement", value: { text: "Evaluate" } },
        { label: "Refs", value: "+refs/heads/dev" },
        { label: "Excluded refs", value: "+refs/heads/tmp" },
        { label: "Rules", value: "+non_fast_forward \u2212deletion" },
        { label: "Rule parameters", value: "pull_request" },
        { label: "Bypass", value: { text: "{count} actors", values: { count: 0 } } },
      ],
      pins,
    })
  })

  test("a new bypass list is a count, and a matching updated_at is accepted", async () => {
    expect(await describeCase(DESCRIBE_CASES.editRulesetBypass)).toEqual({
      headline,
      facts: [{ label: "Bypass", value: { text: "{count} actor", values: { count: 1 } } }],
      pins,
    })
  })

  test("what is in place already says nothing is sent, and still pins", async () => {
    expect(await describeCase(DESCRIBE_CASES.editRulesetNothing)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOTHING_CHANGED } }],
      pins,
    })
  })

  test("the same rules in another order are Replaced", async () => {
    const args = {
      ruleset: 7,
      rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "deletion" }],
    }
    expect((await describeCase({ ...DESCRIBE_CASES.editRulesetBypass, args }))?.facts).toEqual([
      { label: "Rules", value: { text: "Replaced" } },
    ])
  })

  test("the pin follows the ruleset's updated_at", async () => {
    const item = DESCRIBE_CASES.editRulesetBypass
    const later = "2026-11-09T00:00:00Z"
    const description = await describeCase({
      ...item,
      args: { ruleset: 7, bypass: [] },
      rules: rulesetRules({ updated_at: later }),
    })
    expect(description?.pins).toEqual({ updated_at: later })
  })

  const edit = DESCRIBE_CASES.editRulesetBypass
  test.each([
    ["no part at all", { ruleset: 7 }, edit.rules],
    ["an updated_at that is no timestamp", { ...edit.args, updated_at: "yesterday" }, edit.rules],
    ["a ruleset changed since it was read (stale)", { ...edit.args, updated_at: "2026-11-01T00:00:00Z" }, edit.rules],
    ["a ruleset that shows no update time (stale)", edit.args, rulesetRules({ updated_at: null })],
    ["a ruleset the organization defines", edit.args, rulesetRules({ source_type: "Organization", source: "octo" })],
    [
      "a name another ruleset has",
      { ruleset: 7, name: "Other" },
      rulesetRules({}, rawRuleset({ id: 8, name: "other" })),
    ],
    [
      "include on a push ruleset",
      { ruleset: 7, include: ["main"] },
      rulesetRules({ target: "push", conditions: null }),
    ],
    ["a ruleset that does not exist", edit.args, [...repoRules(), restFailure("rulesets/7", "Not Found (HTTP 404)")]],
    [
      "a repository the viewer does not administer",
      edit.args,
      [...repoRules({ viewerPermission: "WRITE" }), ...rulesetRules()],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...edit, args, rules })).toBeUndefined()
  })
})

describe("github_ruleset_delete", () => {
  const item = DESCRIBE_CASES.deleteRuleset

  test("names the ruleset GitHub knows, shows how it is enforced and pins the update", async () => {
    expect(await describeCase(item)).toEqual({
      headline: named("About to delete the ruleset {name}", "Protect main"),
      facts: [
        { label: "Enforcement", value: { text: "Active" } },
        { label: "Target", value: { text: "Branch" } },
        { label: "Rules", value: "deletion, pull_request" },
      ],
      pins: { updated_at: RULESET_UPDATED_AT },
    })
  })

  test("the pin and the enforcement follow the ruleset", async () => {
    const description = await describeCase({
      ...item,
      args: { ruleset: 7 },
      rules: rulesetRules({ updated_at: "2026-11-09T00:00:00Z", enforcement: "disabled" }),
    })
    expect(description?.pins).toEqual({ updated_at: "2026-11-09T00:00:00Z" })
    expect(description?.facts[0]).toEqual({ label: "Enforcement", value: { text: "Disabled" } })
  })

  test.each([
    ["a ruleset changed since it was read (stale)", { ...item.args, updated_at: "2026-11-01T00:00:00Z" }, item.rules],
    ["an updated_at that is no timestamp", { ...item.args, updated_at: "yesterday" }, item.rules],
    ["a ruleset the organization defines", item.args, rulesetRules({ source_type: "Organization", source: "octo" })],
    ["a ruleset that does not exist", item.args, [...repoRules(), restFailure("rulesets/7", "Not Found (HTTP 404)")]],
    ["no ruleset", { updated_at: RULESET_UPDATED_AT }, item.rules],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...item, args, rules })).toBeUndefined()
  })
})

describe("github_label_create", () => {
  const headline = named("About to create the label {name}", "Docs")

  test("a name alone is a headline", async () => {
    expect(await describeCase(DESCRIBE_CASES.createLabel)).toEqual({ headline, facts: [] })
  })

  test("the color as it will be sent, and the description verbatim as text", async () => {
    expect(await describeCase(DESCRIBE_CASES.createLabelFull)).toEqual({
      headline,
      facts: [{ label: "Color", value: "#00AA00" }],
      text: { label: "Description", body: "Documentation" },
    })
  })

  const create = DESCRIBE_CASES.createLabel
  test.each([
    ["a name the repository has, in any case", { name: "BUG" }, create.rules],
    ["a color that is not hex", { name: "Docs", color: "green" }, create.rules],
    ["a repository the viewer cannot write to", create.args, [repositoryRule({ permission: "READ" }), labelPages([])]],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...create, args, rules })).toBeUndefined()
  })
})

describe("github_label_edit", () => {
  const headline = named("About to edit the label {name}", "Bug")

  test("shows each change against what GitHub has, with the new description as text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editLabelEverything)).toEqual({
      headline,
      facts: [
        { label: "Name", value: "Defect" },
        { label: "Color", value: "#d73a4a \u2192 #00ff00" },
      ],
      text: { label: "Description", body: "New words" },
    })
  })

  test("a cleared description is a fact, not text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editLabelClearDescription)).toEqual({
      headline,
      facts: [{ label: "Description", value: { text: "Cleared" } }],
    })
  })

  test("what is in place already says nothing is sent, whatever the case of the color", async () => {
    expect(await describeCase(DESCRIBE_CASES.editLabelNothing)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOTHING_CHANGED } }],
    })
  })

  const edit = DESCRIBE_CASES.editLabelEverything
  test.each([
    ["no change argument", { name: "bug" }, edit.rules],
    ["a label that does not exist", { name: "nope", color: "#00ff00" }, edit.rules],
    [
      "a new name another label has",
      { name: "bug", new_name: "DOCS" },
      labelRules(LABEL_ROW, { ...LABEL_ROW, name: "Docs" }),
    ],
    [
      "a repository the viewer cannot write to",
      edit.args,
      [repositoryRule({ permission: "READ" }), labelPages([LABEL_ROW])],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...edit, args, rules })).toBeUndefined()
  })
})

describe("github_label_delete", () => {
  test("names the label as GitHub spells it, with nothing more to show", async () => {
    expect(await describeCase(DESCRIBE_CASES.deleteLabel)).toEqual({
      headline: named("About to delete the label {name}", "Bug"),
      facts: [],
    })
  })

  const item = DESCRIBE_CASES.deleteLabel
  test.each([
    ["a label that does not exist", { name: "nope" }, item.rules],
    [
      "a repository the viewer cannot write to",
      item.args,
      [repositoryRule({ permission: "READ" }), labelPages([LABEL_ROW])],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...item, args, rules })).toBeUndefined()
  })
})

describe("github_milestone_create", () => {
  const headline = { text: "About to create the milestone {title}", values: { title: "v2" } }

  test("a title alone is a headline", async () => {
    expect(await describeCase(DESCRIBE_CASES.createMilestone)).toEqual({ headline, facts: [] })
  })

  test("the due date as a fact and the description verbatim as text", async () => {
    expect(await describeCase(DESCRIBE_CASES.createMilestoneFull)).toEqual({
      headline,
      facts: [{ label: "Due date", value: "2027-01-31" }],
      text: { label: "Description", body: "The second release" },
    })
  })

  const create = DESCRIBE_CASES.createMilestone
  test.each([
    ["a title the repository has, in any case", { title: "RELEASE" }, create.rules],
    ["a title a closed milestone has", { title: "release" }, milestoneRules({ ...MILESTONE_ROW, state: "CLOSED" })],
    ["a due date that is not a date", { title: "v2", due: "2027-02-30" }, create.rules],
    [
      "a repository the viewer cannot write to",
      create.args,
      [repositoryRule({ permission: "READ" }), milestonePages([])],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...create, args, rules })).toBeUndefined()
  })
})

describe("github_milestone_edit", () => {
  const headline = { text: "About to edit the milestone {title}", values: { title: "Release" } }

  test("by number: each change against what GitHub has, with the new description as text", async () => {
    expect(await describeCase(DESCRIBE_CASES.editMilestoneEverything)).toEqual({
      headline,
      facts: [
        { label: "Title", value: "Release 2" },
        { label: "State", value: { text: "Closed" } },
        { label: "Due date", value: "2026-12-01 \u2192 2027-01-31" },
      ],
      text: { label: "Description", body: "Updated" },
    })
  })

  test("by title in any case, clearing the due date", async () => {
    expect(await describeCase(DESCRIBE_CASES.editMilestoneClearDue)).toEqual({
      headline,
      facts: [{ label: "Due date", value: { text: "Cleared" } }],
    })
  })

  test("reopening and clearing the description", async () => {
    expect(await describeCase(DESCRIBE_CASES.editMilestoneReopen)).toEqual({
      headline,
      facts: [
        { label: "State", value: { text: "Open" } },
        { label: "Description", value: { text: "Cleared" } },
      ],
    })
  })

  test("a due date set where there was none is shown as it is", async () => {
    const item = DESCRIBE_CASES.editMilestoneEverything
    const rules = milestoneRules({ ...MILESTONE_ROW, dueOn: null })
    expect((await describeCase({ ...item, args: { milestone: 1, due: "2027-01-31" }, rules }))?.facts).toEqual([
      { label: "Due date", value: "2027-01-31" },
    ])
  })

  test("what is in place already says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.editMilestoneNothing)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOTHING_CHANGED } }],
    })
  })

  const edit = DESCRIBE_CASES.editMilestoneEverything
  const two = milestoneRules(MILESTONE_ROW, { ...MILESTONE_ROW, number: 2, title: "Other", state: "CLOSED" })
  test.each([
    ["due with clear_due", { milestone: 1, due: "2027-01-31", clear_due: true }, edit.rules],
    ["no change argument", { milestone: 1 }, edit.rules],
    ["a milestone number that does not exist", { milestone: 9, state: "closed" }, edit.rules],
    ["a milestone title that does not exist", { milestone: "nope", state: "closed" }, edit.rules],
    ["a title another milestone has", { milestone: 1, title: "other" }, two],
    [
      "a repository the viewer cannot write to",
      edit.args,
      [repositoryRule({ permission: "READ" }), milestonePages([MILESTONE_ROW])],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...edit, args, rules })).toBeUndefined()
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
