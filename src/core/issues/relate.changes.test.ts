import { describe, expect, test } from "bun:test"
import type { FakeGh, GhRule } from "../../testing/fake-gh"
import { MAX_DEPENDENCIES, MAX_SUB_ISSUES } from "../github/issues"
import { DETAIL, failure, issueBrief } from "../../testing/issue-fixtures"
import { otherRepositoryRule, relationsRules, type CurrentRelations } from "../../testing/relate-fixtures"
import { commands, sent, writeRules, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueRelate } from "./relate"

const { use, run } = writeHarness(issueRelate)

/** The wordings GitHub refuses a duplicate add with. */
const DUPLICATE_SUB_ISSUE =
  "Failed to add sub-issue #3 to parent #1. Issue may not contain duplicate sub-issues (addSubIssue)"
const DUPLICATE_DEPENDENCY =
  "An error occurred while adding the blocking issue to the issue. Validation failed: Target issue has already been taken (addBlockedBy)"

const CURRENT: CurrentRelations = { parent: 1, subIssues: [13, 14], blockedBy: [5], blocking: [6, 7] }
const EDIT = ["issue", "edit", "12", "--repo", "octo/hello"]

/** The rules a call needs: what the test adds first, the relations issue 12 holds, then the usual ones. */
const rulesFor = (current: CurrentRelations, ...extra: GhRule[]): GhRule[] =>
  writeRules(...extra, ...relationsRules(current))

/** The flags and values of each `gh issue edit` call. */
const edits = (installed: FakeGh): string[][] =>
  commands(installed).map((call) => {
    expect(call.args.slice(0, 5)).toEqual(EDIT)
    return call.args.slice(5)
  })

describe("sending only the difference", () => {
  test("what is in the wanted state already is unchanged, and nothing is sent", async () => {
    const installed = use(rulesFor(CURRENT))
    const result = await run({
      issue: "12",
      parent: "1",
      add_sub_issues: ["13"],
      remove_sub_issues: ["99"],
      add_blocked_by: ["octo/hello#5"],
      remove_blocked_by: ["8"],
      add_blocking: ["https://github.com/octo/hello/issues/6"],
      remove_blocking: ["9"],
    })
    expect(result).toEqual({
      repo: "octo/hello",
      issue: 12,
      parent: { before: issueBrief(1), after: "octo/hello#1", changed: false },
      sub_issues: { added: [], removed: [], unchanged: ["octo/hello#99", "octo/hello#13"] },
      blocked_by: { added: [], removed: [], unchanged: ["octo/hello#8", "octo/hello#5"] },
      blocking: { added: [], removed: [], unchanged: ["octo/hello#9", "octo/hello#6"] },
      other_repos: [],
      foreign: false,
    })
    expect(writes(installed)).toEqual([])
    expect(sent(installed).filter((args) => args.join(" ").includes(DETAIL))).toHaveLength(1)
  })

  test("each change is its own call, in a fixed order, with a number in the same repository and a URL across", async () => {
    const installed = use(rulesFor(CURRENT, otherRepositoryRule("other/thing")))
    const result = await run({
      issue: "12",
      add_blocking: ["10"],
      remove_blocking: ["6"],
      add_blocked_by: ["9"],
      remove_blocked_by: ["5"],
      add_sub_issues: ["15", "other/thing#3"],
      remove_sub_issues: ["13"],
      parent: "2",
    })
    expect(edits(installed)).toEqual([
      ["--parent", "2"],
      ["--remove-sub-issue", "13"],
      ["--add-sub-issue", "15"],
      ["--add-sub-issue", "https://github.com/other/thing/issues/3"],
      ["--remove-blocked-by", "5"],
      ["--add-blocked-by", "9"],
      ["--remove-blocking", "6"],
      ["--add-blocking", "10"],
    ])
    expect(result.parent).toEqual({ before: issueBrief(1), after: "octo/hello#2", changed: true })
    expect(result.sub_issues).toEqual({
      added: ["octo/hello#15", "other/thing#3"],
      removed: ["octo/hello#13"],
      unchanged: [],
    })
    expect(result.blocked_by).toEqual({ added: ["octo/hello#9"], removed: ["octo/hello#5"], unchanged: [] })
    expect(result.blocking).toEqual({ added: ["octo/hello#10"], removed: ["octo/hello#6"], unchanged: [] })
  })

  test("a parent in another repository goes as a URL", async () => {
    const installed = use(rulesFor({}, otherRepositoryRule("other/thing")))
    const result = await run({ issue: "12", parent: "https://github.com/other/thing/issues/1" })
    expect(edits(installed)).toEqual([["--parent", "https://github.com/other/thing/issues/1"]])
    expect(result.parent).toEqual({ before: null, after: "other/thing#1", changed: true })
  })

  test("remove_parent sends --remove-parent alone", async () => {
    const installed = use(rulesFor(CURRENT))
    const result = await run({ issue: "12", remove_parent: true })
    expect(result.parent).toEqual({ before: issueBrief(1), after: null, changed: true })
    expect(edits(installed)).toEqual([["--remove-parent"]])
  })

  test("a parent that is not there is left, and nothing is sent", async () => {
    const installed = use(rulesFor({}))
    const result = await run({ issue: "12", remove_parent: true })
    expect(result.parent).toEqual({ before: null, after: null, changed: false })
    expect(writes(installed)).toEqual([])
  })

  test("a parent left alone is reported as it is", async () => {
    use(rulesFor(CURRENT))
    const result = await run({ issue: "12", add_sub_issues: ["20"] })
    expect(result.parent).toEqual({ before: issueBrief(1), after: "octo/hello#1", changed: false })
  })
})

describe("GitHub's refusals", () => {
  test.each([
    [
      "adding a sub-issue it holds",
      { add_sub_issues: ["15"] },
      "--add-sub-issue 15$",
      DUPLICATE_SUB_ISSUE,
      "sub_issues",
    ],
    [
      "adding a blocker it holds",
      { add_blocked_by: ["15"] },
      "--add-blocked-by 15$",
      DUPLICATE_DEPENDENCY,
      "blocked_by",
    ],
    [
      "adding a blocked issue it holds",
      { add_blocking: ["15"] },
      "--add-blocking 15$",
      DUPLICATE_DEPENDENCY,
      "blocking",
    ],
  ] as const)("%s is unchanged", async (_name, args, match, stderr, relation) => {
    const installed = use(rulesFor(CURRENT, { match, stderr, code: 1 }))
    const result = await run({ issue: "12", ...args })
    expect(result[relation]).toEqual({ added: [], removed: [], unchanged: ["octo/hello#15"] })
    expect(edits(installed)).toHaveLength(1)
  })

  test("a parent GitHub says is a duplicate is unchanged", async () => {
    use(rulesFor(CURRENT, { match: "--parent 2$", stderr: DUPLICATE_SUB_ISSUE, code: 1 }))
    const result = await run({ issue: "12", parent: "2" })
    expect(result.parent).toEqual({ before: issueBrief(1), after: "octo/hello#2", changed: false })
  })

  test.each([
    ["a sub-issue", { add_sub_issues: ["15"] }, "--add-sub-issue 15$", DUPLICATE_DEPENDENCY],
    ["a parent", { parent: "2" }, "--parent 2$", DUPLICATE_DEPENDENCY],
    ["a blocker", { add_blocked_by: ["9"] }, "--add-blocked-by 9$", DUPLICATE_SUB_ISSUE],
    ["a blocked issue", { add_blocking: ["9"] }, "--add-blocking 9$", DUPLICATE_SUB_ISSUE],
  ] as const)(
    "the other relation's duplicate wording does not excuse adding %s",
    async (_name, args, match, stderr) => {
      use(rulesFor(CURRENT, { match, stderr, code: 1 }))
      expect((await failure(run({ issue: "12", ...args }))).code).toBe("github_error")
    },
  )

  test("a refusal that is not about the link being there is a failure", async () => {
    use(rulesFor(CURRENT, { match: "--add-sub-issue 15$", stderr: "GraphQL: Sub issue limit reached", code: 1 }))
    expect((await failure(run({ issue: "12", add_sub_issues: ["15"] }))).code).toBe("github_error")
  })
})

describe("a list that fills its page", () => {
  const numbers = (count: number) => Array.from({ length: count }, (_, index) => 100 + index)
  const PAGES = [
    ["sub-issues", MAX_SUB_ISSUES, "subIssues", "sub_issues", "--remove-sub-issue", "remove_sub_issues"],
    ["blocked-by", MAX_DEPENDENCIES, "blockedBy", "blocked_by", "--remove-blocked-by", "remove_blocked_by"],
    ["blocking", MAX_DEPENDENCIES, "blocking", "blocking", "--remove-blocking", "remove_blocking"],
  ] as const

  test.each(PAGES)(
    "a removal missing from a full list of %s is sent and reported as removed",
    async (_name, size, key, relation, flag, argument) => {
      const installed = use(rulesFor({ [key]: numbers(size) }))
      const result = await run({ issue: "12", [argument]: ["5"] })
      expect(edits(installed)).toEqual([[flag, "5"]])
      expect(result[relation]).toEqual({ added: [], removed: ["octo/hello#5"], unchanged: [] })
    },
  )

  test.each(PAGES)(
    "a removal missing from a list of %s one short of the page is not sent",
    async (_name, size, key, relation, _flag, argument) => {
      const installed = use(rulesFor({ [key]: numbers(size - 1) }))
      const result = await run({ issue: "12", [argument]: ["5"] })
      expect(writes(installed)).toEqual([])
      expect(result[relation]).toEqual({ added: [], removed: [], unchanged: ["octo/hello#5"] })
    },
  )

  test.each(PAGES)(
    "a removal found in a full list of %s is sent once",
    async (_name, size, key, relation, flag, argument) => {
      const installed = use(rulesFor({ [key]: numbers(size) }))
      const result = await run({ issue: "12", [argument]: ["100"] })
      expect(edits(installed)).toEqual([[flag, "100"]])
      expect(result[relation].removed).toEqual(["octo/hello#100"])
    },
  )

  test("an addition that a full list hides is refused as a duplicate, and is unchanged", async () => {
    use(
      rulesFor(
        { blockedBy: numbers(MAX_DEPENDENCIES) },
        { match: "--add-blocked-by 5$", stderr: DUPLICATE_DEPENDENCY, code: 1 },
      ),
    )
    const result = await run({ issue: "12", add_blocked_by: ["5"] })
    expect(result.blocked_by).toEqual({ added: [], removed: [], unchanged: ["octo/hello#5"] })
  })
})

describe("dependencies that cannot be read", () => {
  test("a dependency change fails before any write, naming why", async () => {
    const installed = use(rulesFor({ ...CURRENT, dependenciesError: true }))
    const error = await failure(run({ issue: "12", add_sub_issues: ["15"], remove_blocking: ["6"] }))
    expect(error.code).toBe("github_error")
    expect(error.message).toContain("cannot be changed here")
    expect(error.message).toContain("blockedBy")
    expect(writes(installed)).toEqual([])
  })

  test("a change of the parent or the sub-issues still goes through", async () => {
    const installed = use(rulesFor({ ...CURRENT, dependenciesError: true }))
    const result = await run({ issue: "12", parent: "2", add_sub_issues: ["15"] })
    expect(result.parent.changed).toBe(true)
    expect(result.sub_issues.added).toEqual(["octo/hello#15"])
    expect(edits(installed)).toEqual([
      ["--parent", "2"],
      ["--add-sub-issue", "15"],
    ])
  })
})

describe("a failure part-way", () => {
  test("keeps the code, names what was applied, and says a rerun is safe", async () => {
    const installed = use(rulesFor(CURRENT, { match: "--add-sub-issue 16$", stderr: "HTTP 403: Forbidden", code: 1 }))
    const error = await failure(run({ issue: "12", parent: "2", add_sub_issues: ["15", "16", "17"] }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("HTTP 403: Forbidden")
    expect(error.message).toContain("--parent octo/hello#2; --add-sub-issue octo/hello#15")
    expect(error.message).not.toContain("octo/hello#17")
    expect(error.message).toContain("rerunning the same call is safe")
    expect(edits(installed)).toHaveLength(3)
  })

  test("a failure of the first change says nothing was applied", async () => {
    use(rulesFor(CURRENT, { match: "--add-blocked-by 9$", stderr: "HTTP 500", code: 1 }))
    const error = await failure(run({ issue: "12", add_blocked_by: ["9"] }))
    expect(error.code).toBe("github_error")
    expect(error.message).toContain("Applied before this failure: nothing.")
  })

  test("a change that was tolerated is not listed as applied", async () => {
    use(
      rulesFor(
        CURRENT,
        { match: "--add-sub-issue 15$", stderr: DUPLICATE_SUB_ISSUE, code: 1 },
        { match: "--add-blocked-by 9$", stderr: "HTTP 500", code: 1 },
      ),
    )
    const error = await failure(run({ issue: "12", add_sub_issues: ["15"], add_blocked_by: ["9"] }))
    expect(error.message).toContain("Applied before this failure: nothing.")
  })
})
