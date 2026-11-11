import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { gqlReply } from "../../testing/gql"
import { failure } from "../../testing/issue-fixtures"
import {
  FIELDS,
  commands,
  editedRule,
  issueFieldsRule,
  issueTypesRule,
  labelRule,
  milestoneCreatedRule,
  milestonesRule,
  repositoryRule,
  sent,
  writeRules,
  writes,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueEdit } from "./edit"

const { use, run } = writeHarness(issueEdit)

const EDIT = ["issue", "edit", "12", "--repo", "octo/hello"]
const TYPE_REFUSED = "GraphQL: Issue type is not enabled for this repository"

/** The rules every call needs, after the ones a test adds, with an edit that prints issue 12's URL. */
const base = (...rules: GhRule[]): GhRule[] => writeRules(...rules, editedRule(12))

describe("the milestone", () => {
  test("a missing one fails before the edit, naming create_milestone", async () => {
    const installed = use(base(milestonesRule("v1")))
    const error = await failure(run({ issue: "12", title: "T", milestone: "v9" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("create_milestone: true")
    expect(writes(installed)).toEqual([])
  })

  test("an unknown issue is not_found, and create_milestone makes no milestone for it", async () => {
    const installed = use(
      base(
        { match: FIELDS, stdout: gqlReply({ repository: { issue: null } }) },
        milestonesRule("v1"),
        milestoneCreatedRule(4, "v9"),
      ),
    )
    const error = await failure(run({ issue: "99", milestone: "v9", create_milestone: true }))
    expect(error.code).toBe("not_found")
    expect(writes(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("milestones"))).toBe(false)
  })

  test("create_milestone makes it first, then the edit uses it", async () => {
    const installed = use(base(issueFieldsRule(), milestonesRule("v1"), milestoneCreatedRule(4, "v9")))
    const result = await run({ issue: "12", milestone: "v9", create_milestone: true })
    expect(result.milestone).toEqual({ number: 4, title: "v9", created: true })
    expect(writes(installed)).toEqual([
      ["api", "-X", "POST", "repos/octo/hello/milestones", "-f", "title=v9"],
      [...EDIT, "--milestone", "v9"],
    ])
  })

  test("remove_milestone takes the issue out, and the result has no milestone", async () => {
    const installed = use(base())
    const result = await run({ issue: "12", remove_milestone: true })
    expect(result.changed).toEqual(["remove_milestone"])
    expect(result.milestone).toBeNull()
    expect(commands(installed)[0]!.args).toEqual([...EDIT, "--remove-milestone"])
  })
})

describe("the kind", () => {
  test("an Issue Type of that name is set with --type", async () => {
    const installed = use([
      issueFieldsRule({ labels: ["type:chore"] }),
      issueTypesRule("Bug"),
      repositoryRule(),
      editedRule(12),
    ])
    const result = await run({ issue: "12", kind: "bug" })
    expect(result.kind).toEqual({ name: "Bug", via: "type" })
    expect(result.changed).toEqual(["kind"])
    expect(commands(installed).map((call) => call.args)).toEqual([[...EDIT, "--type", "Bug"]])
  })

  test("else the label is added and every other type: label comes off, others stay", async () => {
    const installed = use(
      base(issueFieldsRule({ labels: ["bug", "type:feature", "Type:Docs", "type:chore"] }), labelRule(false), {
        match: "^label create",
      }),
    )
    const result = await run({ issue: "12", kind: "docs" })
    expect(result.kind).toEqual({ name: "type:docs", via: "label" })
    expect(commands(installed).map((call) => call.args)).toEqual([
      ["label", "create", "type:docs", "--repo", "octo/hello"],
      [...EDIT, "--add-label", "type:docs", "--remove-label", "type:feature", "--remove-label", "type:chore"],
    ])
  })

  test("a label the call itself adds or removes is left to the call", async () => {
    const installed = use(base(issueFieldsRule({ labels: ["type:feature", "type:chore"] }), labelRule(true)))
    await run({ issue: "12", kind: "docs", add_labels: ["Type:Feature"], remove_labels: ["type:chore"] })
    expect(commands(installed)[0]!.args).toEqual([
      ...EDIT,
      "--add-label",
      "Type:Feature",
      "--remove-label",
      "type:chore",
      "--add-label",
      "type:docs",
    ])
  })

  test("a type GitHub refuses is retried once as a label, with the same body and no second append", async () => {
    const installed = use([
      { match: "--type Bug", stderr: TYPE_REFUSED, code: 1 },
      issueFieldsRule({ body: "Old", labels: ["type:feature"] }),
      issueTypesRule("Bug"),
      labelRule(true),
      repositoryRule(),
      editedRule(12),
    ])
    const result = await run({ issue: "12", kind: "bug", append_body: "More" })
    expect(result.kind).toEqual({ name: "type:bug", via: "label" })
    expect(result.changed).toEqual(["append_body", "kind"])
    expect(commands(installed)).toEqual([
      { args: [...EDIT, "--body-file", "-", "--type", "Bug"], stdin: "Old\n\nMore" },
      {
        args: [...EDIT, "--body-file", "-", "--add-label", "type:bug", "--remove-label", "type:feature"],
        stdin: "Old\n\nMore",
      },
    ])
    expect(sent(installed).filter((args) => args.join(" ").includes("stateReason body labels"))).toHaveLength(1)
  })

  test("a failure that is not about the type is thrown, without a retry", async () => {
    const installed = use([
      { match: "^issue edit", stderr: "HTTP 500", code: 1 },
      issueFieldsRule(),
      issueTypesRule("Bug"),
      repositoryRule(),
    ])
    expect((await failure(run({ issue: "12", kind: "bug" }))).code).toBe("upstream_error")
    expect(commands(installed)).toHaveLength(1)
  })

  test("a label that fails is thrown too, and is not retried", async () => {
    const installed = use([
      { match: "^issue edit", stderr: "HTTP 422: type is invalid", code: 1 },
      ...base(issueFieldsRule(), labelRule(true)),
    ])
    expect((await failure(run({ issue: "12", kind: "bug" }))).code).toBe("upstream_error")
    expect(commands(installed)).toHaveLength(1)
  })
})
