import { describe, expect, test } from "bun:test"
import { branchRule, defaultBranchRule } from "../../testing/develop-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import {
  STATE,
  noPullRequestRule,
  prCommands,
  prEditedRule,
  linkedIssues,
  prWrites,
  rawClosingIssue,
  stateRule,
} from "../../testing/pull-request-write-fixtures"
import { milestonesRule, repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prEdit } from "./edit"
import { CLOSING_POLL_INTERVAL_MS, CLOSING_POLL_TIMEOUT_MS } from "./write-support"

const { use, run } = writeHarness(prEdit)

const EDIT = ["pr", "edit", "7", "--repo", "octo/hello"]
const URL = "https://github.com/octo/hello/pull/7"

/** The rules every call needs, after the ones a test adds: write permission and an edit that prints pull request 7's URL. */
const base = (...rules: GhRule[]): GhRule[] => [...rules, repositoryRule(), prEditedRule(7)]

const readsOf = (installed: Parameters<typeof sent>[0]) =>
  sent(installed).filter((args) => new RegExp(STATE).test(args.join(" ")))

describe("one gh pr edit", () => {
  test("a title alone: nothing is read, and the result says what changed", async () => {
    const installed = use(base())
    expect(await run({ pr: "7", title: "  New title " })).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      changed: ["title"],
      milestone: null,
      attachments: [],
      notes: [],
      foreign: false,
      errors: {},
    })
    expect(prCommands(installed)).toEqual([{ args: [...EDIT, "--title", "New title"], stdin: "" }])
    expect(readsOf(installed)).toEqual([])
  })

  test("a body replaces the old one and goes on stdin, also an empty one", async () => {
    const installed = use(base())
    await run({ pr: "7", body: "New\n\nbody" })
    expect((await run({ pr: "7", body: "" })).changed).toEqual(["body"])
    expect(prCommands(installed)).toEqual([
      { args: [...EDIT, "--body-file", "-"], stdin: "New\n\nbody" },
      { args: [...EDIT, "--body-file", "-"], stdin: "" },
    ])
  })

  test("every list, the base and the milestone become flags, in a fixed order", async () => {
    const installed = use(base(milestonesRule("v1"), stateRule(), branchRule("octo/hello", "release", true)))
    const result = await run({
      pr: "#7",
      title: "T",
      body: "B",
      base: "release",
      add_labels: ["a", "b"],
      remove_labels: ["c"],
      add_assignees: ["@me"],
      remove_assignees: ["bob", "carol"],
      add_reviewers: ["dave", "octo/core"],
      remove_reviewers: ["erin"],
      milestone: "V1",
    })
    expect(prCommands(installed)).toEqual([
      {
        args: [
          ...EDIT,
          "--title",
          "T",
          "--body-file",
          "-",
          "--base",
          "release",
          "--add-label",
          "a",
          "--add-label",
          "b",
          "--remove-label",
          "c",
          "--add-assignee",
          "@me",
          "--remove-assignee",
          "bob",
          "--remove-assignee",
          "carol",
          "--add-reviewer",
          "dave",
          "--add-reviewer",
          "octo/core",
          "--remove-reviewer",
          "erin",
          "--milestone",
          "v1",
        ],
        stdin: "B",
      },
    ])
    expect(result.changed).toEqual([
      "title",
      "body",
      "base",
      "add_labels",
      "remove_labels",
      "add_assignees",
      "remove_assignees",
      "add_reviewers",
      "remove_reviewers",
      "milestone",
    ])
    expect(result.milestone).toEqual({ number: 1, title: "v1", created: false })
  })

  test("remove_milestone is a flag of its own", async () => {
    const installed = use(base())
    const result = await run({ pr: "7", remove_milestone: true })
    expect(prCommands(installed)[0]!.args).toEqual([...EDIT, "--remove-milestone"])
    expect(result).toMatchObject({ changed: ["remove_milestone"], milestone: null })
  })

  test("a pull request URL names its own repository", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), prEditedRule(3, "other/thing")])
    const result = await run({ pr: "https://github.com/other/thing/pull/3", title: "T" })
    expect(result.repo).toBe("other/thing")
    expect(prCommands(installed)[0]!.args.slice(0, 5)).toEqual(["pr", "edit", "3", "--repo", "other/thing"])
  })

  test("a gh that prints no URL falls back to the pull request's address", async () => {
    use([repositoryRule(), { match: "^pr edit" }])
    expect((await run({ pr: "7", title: "T" })).url).toBe(URL)
  })
})

describe("append_body", () => {
  test("reads the body, then writes once: the old text, a blank line, the new text", async () => {
    const installed = use(base(stateRule({ body: "It works.\n\n" })))
    const result = await run({ pr: "7", append_body: "## Update\nFixed in main." })
    expect(prCommands(installed)).toEqual([
      { args: [...EDIT, "--body-file", "-"], stdin: "It works.\n\n## Update\nFixed in main." },
    ])
    expect(result.changed).toEqual(["append_body"])
    const calls = sent(installed).map((args) => args.join(" "))
    expect(calls.findIndex((call) => new RegExp(STATE).test(call))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("pr edit")),
    )
    expect(readsOf(installed)).toHaveLength(1)
  })

  test("an empty body takes the text alone", async () => {
    const installed = use(base(stateRule({ body: " \n" })))
    await run({ pr: "7", append_body: "First words." })
    expect(prCommands(installed)[0]!.stdin).toBe("First words.")
  })

  test("goes before the closing lines the body ends with, whether or not closes change", async () => {
    const installed = use(base(stateRule({ body: "Intro\n\nCloses #1\nFixes other/thing#2\n" })))
    const result = await run({ pr: "7", append_body: "More." })
    expect(prCommands(installed)[0]!.stdin).toBe("Intro\n\nMore.\n\nCloses #1\nFixes other/thing#2")
    expect(result.notes).toEqual([])
  })

  test("a closing line in the middle of the body is not a block to keep last", async () => {
    const installed = use(base(stateRule({ body: "Closes #1\n\nOutro" })))
    await run({ pr: "7", append_body: "More." })
    expect(prCommands(installed)[0]!.stdin).toBe("Closes #1\n\nOutro\n\nMore.")
  })

  test("a body of closing lines only keeps them last", async () => {
    const installed = use(base(stateRule({ body: "Closes #1" })))
    await run({ pr: "7", append_body: "More." })
    expect(prCommands(installed)[0]!.stdin).toBe("More.\n\nCloses #1")
  })
})

describe("closing issues", () => {
  test("add_closes puts a Closes line at the end of the body, and the result lists what GitHub links", async () => {
    const linked = { closingIssuesReferences: { nodes: [rawClosingIssue(12)] } }
    const installed = use(
      base(
        stateRule({ body: "Intro" }, 1),
        stateRule({ body: "Intro\n\nCloses #12", ...linked }),
        defaultBranchRule("main"),
      ),
    )
    const result = await run({ pr: "7", add_closes: ["12"] })
    expect(prCommands(installed)).toEqual([{ args: [...EDIT, "--body-file", "-"], stdin: "Intro\n\nCloses #12" }])
    expect(result).toMatchObject({
      changed: ["add_closes"],
      closing_issues: [
        {
          number: 12,
          title: "Issue 12",
          url: "https://github.com/octo/hello/issues/12",
          state: "open",
          repo: "octo/hello",
        },
      ],
      notes: [],
    })
    expect(readsOf(installed)).toHaveLength(2)
  })

  test("an issue of another repository is named with it, and added to an explicit body", async () => {
    const linked = linkedIssues(rawClosingIssue(3, "other/thing"), rawClosingIssue(4))
    const installed = use(base(stateRule({}, 1), stateRule(linked), defaultBranchRule("main")))
    await run({ pr: "7", body: "Fresh", add_closes: ["other/thing#3", "https://github.com/octo/hello/issues/4"] })
    expect(prCommands(installed)[0]!.stdin).toBe("Fresh\n\nCloses other/thing#3\nCloses #4")
  })

  test("a line the body has already is not added twice", async () => {
    const installed = use(
      base(
        stateRule({ body: "Body\n\nfixes #12" }, 1),
        stateRule(linkedIssues(rawClosingIssue(12))),
        defaultBranchRule("main"),
      ),
    )
    await run({ pr: "7", add_closes: ["#12"] })
    expect(prCommands(installed)[0]!.stdin).toBe("Body\n\nfixes #12")
  })

  test("remove_closes takes the lines out, and says when the issue is still linked", async () => {
    // Into another branch than the default, so GitHub is not waited for.
    const still = linkedIssues(rawClosingIssue(12), rawClosingIssue(13))
    const installed = use(
      base(
        stateRule({ body: "Body\n\nCloses #12\nCloses #13", baseRefName: "release" }, 1),
        stateRule({ body: "Body\n\nCloses #13", baseRefName: "release", ...still }),
        defaultBranchRule("main"),
      ),
    )
    const result = await run({ pr: "7", remove_closes: ["12", "octo/hello#13"] })
    expect(prCommands(installed)[0]!.stdin).toBe("Body")
    expect(result.changed).toEqual(["remove_closes"])
    expect(result.notes).toEqual([
      "octo/hello#12 is still linked: the body or a commit message mentions it in another form.",
      "octo/hello#13 is still linked: the body or a commit message mentions it in another form.",
    ])
    expect(result.closing_issues?.map((issue) => issue.number)).toEqual([12, 13])
  })

  test("a removed issue that is no longer linked brings no note", async () => {
    const installed = use(base(stateRule({ body: "Closes #12" }, 1), stateRule(), defaultBranchRule("main")))
    const result = await run({ pr: "7", remove_closes: ["12"] })
    expect(result).toMatchObject({ closing_issues: [], notes: [] })
    expect(readsOf(installed)).toHaveLength(2)
  })

  test("a pull request into another branch than the default says its issues are not linked, and is not waited for", async () => {
    const installed = use(
      base(stateRule({ baseRefName: "release" }, 1), stateRule({ baseRefName: "release" }), defaultBranchRule("main")),
    )
    const result = await run({ pr: "7", add_closes: ["12"] })
    expect(result.notes).toEqual([
      "GitHub links closing issues only for a pull request into the default branch (main); this one is into release, so the issues are named in the body but not linked.",
    ])
    expect(readsOf(installed)).toHaveLength(2)
  })

  test("a closing change with other arguments is one edit, and the body sent has the lines", async () => {
    const installed = use(
      base(stateRule({ body: "Body" }, 1), stateRule(linkedIssues(rawClosingIssue(1))), defaultBranchRule("main")),
    )
    await run({ pr: "7", title: "T", add_closes: ["1"] })
    expect(prCommands(installed)).toEqual([
      { args: [...EDIT, "--title", "T", "--body-file", "-"], stdin: "Body\n\nCloses #1" },
    ])
  })

  test("append_body and closes together: the lines go after the appended text", async () => {
    const installed = use(
      base(stateRule({ body: "Old" }, 1), stateRule(linkedIssues(rawClosingIssue(1))), defaultBranchRule("main")),
    )
    await run({ pr: "7", append_body: "New", add_closes: ["1"] })
    expect(prCommands(installed)[0]!.stdin).toBe("Old\n\nNew\n\nCloses #1")
  })

  test("swapping a closing line around appended text leaves no blank gap and keeps the lines last", async () => {
    const installed = use(
      base(
        stateRule({ body: "A probe.\n\nCloses #2", ...linkedIssues(rawClosingIssue(2)) }, 1),
        stateRule(linkedIssues(rawClosingIssue(3))),
        defaultBranchRule("main"),
      ),
    )
    const result = await run({ pr: "7", append_body: "More text.", add_closes: ["3"], remove_closes: ["2"] })
    expect(prCommands(installed)[0]!.stdin).toBe("A probe.\n\nMore text.\n\nCloses #3")
    expect(result.notes).toEqual([])
  })

  test("GitHub links asynchronously: the closing issues are read again until they match, and no longer", async () => {
    const installed = use(
      base(
        stateRule({ body: "A probe.\n\nCloses #2" }, 1),
        // Right after the edit GitHub still shows the old link ...
        stateRule(linkedIssues(rawClosingIssue(2)), 1),
        // ... and a second later the new one.
        stateRule(linkedIssues(rawClosingIssue(3))),
        defaultBranchRule("main"),
      ),
    )
    const started = Date.now()
    const result = await run({ pr: "7", add_closes: ["3"], remove_closes: ["2"] })
    expect(result.closing_issues?.map((issue) => issue.number)).toEqual([3])
    expect(result.notes).toEqual([])
    expect(readsOf(installed)).toHaveLength(3)
    expect(Date.now() - started).toBeLessThan(CLOSING_POLL_TIMEOUT_MS)
  })

  test("an issue GitHub has not linked, nor unlinked, when the wait ends is told in notes", async () => {
    const installed = use(
      base(stateRule({ body: "Closes #2" }, 1), stateRule(linkedIssues(rawClosingIssue(2))), defaultBranchRule("main")),
    )
    const result = await run({ pr: "7", add_closes: ["3"], remove_closes: ["2"] })
    expect(result.notes).toEqual([
      "GitHub had not linked octo/hello#3 yet when this call returned; github_pr_read view shows it once it does.",
      "octo/hello#2 is still linked: the body or a commit message mentions it in another form.",
    ])
    expect(readsOf(installed).length).toBeGreaterThan(3)
    expect(readsOf(installed).length).toBeLessThanOrEqual(2 + CLOSING_POLL_TIMEOUT_MS / CLOSING_POLL_INTERVAL_MS)
  }, 15_000)

  test("a poll that fails ends the wait with what was read", async () => {
    use(base(stateRule({}, 1), stateRule({}, 1), { match: STATE, stderr: "boom", code: 1 }, defaultBranchRule("main")))
    const result = await run({ pr: "7", add_closes: ["3"] })
    expect(result.closing_issues).toEqual([])
    expect(result.notes).toEqual([
      "GitHub had not linked octo/hello#3 yet when this call returned; github_pr_read view shows it once it does.",
    ])
  })

  test("a read-back that fails is told in a note, and the edit still stands", async () => {
    const installed = use(base(stateRule({}, 1), { match: STATE, stderr: "boom", code: 1 }, defaultBranchRule("main")))
    const result = await run({ pr: "7", add_closes: ["1"] })
    expect(result.closing_issues).toBeUndefined()
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain("could not be read back")
    expect(prWrites(installed)).toHaveLength(1)
  })

  test("a pull request that does not exist is not_found, and nothing is written", async () => {
    const installed = use(base(noPullRequestRule()))
    expect((await failure(run({ pr: "7", add_closes: ["1"] }))).code).toBe("not_found")
    expect(prWrites(installed)).toEqual([])
  })
})

describe("base", () => {
  test("a merged pull request keeps its base", async () => {
    const installed = use(base(stateRule({ state: "MERGED" }), branchRule("octo/hello", "release", true)))
    const error = await failure(run({ pr: "7", base: "release" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("merged")
    expect(prWrites(installed)).toEqual([])
  })

  test("the head branch cannot be the base", async () => {
    const installed = use(base(stateRule(), branchRule("octo/hello", "feature", true)))
    const error = await failure(run({ pr: "7", base: "feature" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("head branch")
    expect(prWrites(installed)).toEqual([])
  })

  test("a base that is not on the repository is refused", async () => {
    const installed = use(base(stateRule(), branchRule("octo/hello", "ghost", false)))
    const error = await failure(run({ pr: "7", base: "ghost" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('base branch "ghost" is not on octo/hello.')
    expect(prWrites(installed)).toEqual([])
  })

  test("a blank base is refused before any call", async () => {
    const installed = use(base(stateRule()))
    expect((await failure(run({ pr: "7", base: " " }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})

describe("before anything is written", () => {
  test.each([
    ["nothing to change", { pr: "7" }, "Nothing to change"],
    ["only empty lists", { pr: "7", add_labels: [" "], remove_closes: [] }, "Nothing to change"],
    ["a blank title", { pr: "7", title: "  " }, "title is blank"],
    ["body and append_body", { pr: "7", body: "a", append_body: "b" }, "pass one of them"],
    ["a blank milestone", { pr: "7", milestone: " " }, "milestone is blank"],
    ["milestone and remove_milestone", { pr: "7", milestone: "v1", remove_milestone: true }, "contradict"],
    ["a label added and removed", { pr: "7", add_labels: ["Bug"], remove_labels: ["bug"] }, "Label Bug"],
    ["an assignee added and removed", { pr: "7", add_assignees: ["a"], remove_assignees: ["A"] }, "Assignee a"],
    ["a reviewer added and removed", { pr: "7", add_reviewers: ["a"], remove_reviewers: ["a"] }, "Reviewer a"],
    [
      "a closing issue added and removed, in two forms",
      { pr: "7", add_closes: ["12"], remove_closes: ["octo/hello#12"] },
      "octo/hello#12 cannot be both added and removed",
    ],
    ["a list value gh would split", { pr: "7", add_labels: ["a,b"] }, "list syntax"],
    ["a closing reference that is none", { pr: "7", add_closes: ["twelve"] }, "not an issue or pull request reference"],
    [
      "a closing reference that is a pull request URL",
      { pr: "7", add_closes: ["https://github.com/octo/hello/pull/3"] },
      "not an issue",
    ],
    [
      "an issue URL as the pull request",
      { pr: "https://github.com/octo/hello/issues/7", title: "T" },
      "not a pull request",
    ],
    ["a create_milestone", { pr: "7", milestone: "v1", create_milestone: true }, "unknown argument"],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args, expected) => {
    const installed = use(base(stateRule()))
    const error = await failure(run(args))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(sent(installed)).toEqual([])
  })

  test("a milestone that does not exist fails, and the pull request is not changed", async () => {
    const installed = use(base(milestonesRule("v1")))
    const error = await failure(run({ pr: "7", title: "T", milestone: "v9" }))
    expect(error.code).toBe("invalid_argument")
    expect(prWrites(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), prEditedRule(7)])
    expect((await failure(run({ pr: "7", title: "T" }))).code).toBe("forbidden")
    expect(prWrites(installed)).toEqual([])
  })

  test("a failing gh is thrown", async () => {
    use([repositoryRule(), { match: "^pr edit", stderr: "HTTP 500", code: 1 }])
    expect((await failure(run({ pr: "7", title: "T" }))).code).toBe("github_error")
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), prEditedRule(7)])
    expect((await run({ pr: "7", title: "T" })).foreign).toBe(true)
  })
})
