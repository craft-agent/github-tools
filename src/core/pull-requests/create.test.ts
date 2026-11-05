import { describe, expect, test } from "bun:test"
import {
  BOARD_SUMMARY,
  addItemRule,
  boardWithFields,
  mutationNames,
  mutationsOf,
  setValueRule,
} from "../../testing/board-write-fixtures"
import { HEAD_SHA, branchRule, defaultBranchRule } from "../../testing/develop-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { octoBoardRules } from "../../testing/project-fixtures"
import {
  STATE,
  prCommands,
  prCreatedRule,
  prEditedRule,
  linkedIssues,
  prWrites,
  rawClosingIssue,
  stateRule,
} from "../../testing/pull-request-write-fixtures"
import { milestonesRule, repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prCreate } from "./create"
import { CLOSING_POLL_TIMEOUT_MS } from "./write-support"

const { use, run } = writeHarness(prCreate)

const NO_OPEN: GhRule = { match: "^pr list", stdout: "[]" }
const URL = "https://github.com/octo/hello/pull/7"
const OTHER_SHA = "f".repeat(40)

/** The rules of a call that finds both branches, no pull request open yet and the default branch `main`. */
const base = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  repositoryRule(),
  defaultBranchRule("main"),
  branchRule("octo/hello", "main", true),
  branchRule("octo/hello", "feature", true),
  NO_OPEN,
  prCreatedRule(7),
  prEditedRule(7),
  stateRule(),
]

const queried = (installed: Parameters<typeof sent>[0], text: string) =>
  sent(installed).some((args) => args.join(" ").includes(text))

const CREATE = ["pr", "create", "--repo", "octo/hello", "--base", "main", "--head", "feature"]

describe("one gh pr create", () => {
  test("the arguments become flags in a fixed order, the body with its closing lines goes on stdin", async () => {
    const installed = use(
      base(
        milestonesRule("v1"),
        stateRule({ isDraft: true, closingIssuesReferences: { nodes: [rawClosingIssue(12)] } }),
      ),
    )
    const result = await run({
      head: "feature",
      title: "  Add the thing ",
      body: "Does the thing.\n",
      draft: true,
      labels: ["a", "b"],
      assignees: ["@me"],
      reviewers: ["dave", "octo/core"],
      milestone: "V1",
      closes: ["12"],
    })
    expect(result).toEqual({
      repo: "octo/hello",
      pr: { number: 7, url: URL, title: "Add the thing" },
      base: "main",
      head: "feature",
      head_sha: HEAD_SHA,
      draft: true,
      closing_issues: [
        {
          number: 12,
          title: "Issue 12",
          url: "https://github.com/octo/hello/issues/12",
          state: "open",
          repo: "octo/hello",
        },
      ],
      project: null,
      notes: [],
      foreign: false,
      errors: {},
    })
    // Only what makes the pull request goes to create; the labels, people and milestone follow in one edit.
    const [create, edit] = prCommands(installed).filter((call) => call.args[1] !== "list")
    expect(create).toEqual({
      args: [...CREATE, "--title", "Add the thing", "--body-file", "-", "--draft"],
      stdin: "Does the thing.\n\nCloses #12",
    })
    expect(edit!.args.join(" ")).toBe(
      "pr edit 7 --repo octo/hello --add-label a --add-label b --add-assignee @me --add-reviewer dave --add-reviewer octo/core --milestone v1",
    )
    expect(prCommands(installed)).toHaveLength(3)
  })

  test("a bare call: the default branch is the base, the body is empty and the pull request is not a draft", async () => {
    const installed = use(base())
    const result = await run({ head: "feature", title: "T" })
    expect(prCommands(installed).filter((call) => call.args[1] === "create")).toEqual([
      { args: [...CREATE, "--title", "T", "--body-file", "-"], stdin: "" },
    ])
    expect(result).toMatchObject({ base: "main", draft: false, closing_issues: [], project: null, errors: {} })
    expect(queried(installed, "defaultBranchRef")).toBe(true)
  })

  test("a body without closes is sent as it is", async () => {
    const installed = use(base())
    await run({ head: "feature", title: "T", body: "Text\n\n" })
    expect(prCommands(installed).find((call) => call.args[1] === "create")!.stdin).toBe("Text\n\n")
  })

  test("an explicit base is not looked up as the default, unless closes need the comparison", async () => {
    const installed = use(base(branchRule("octo/hello", "release", true)))
    await run({ head: "feature", title: "T", base: "release" })
    expect(queried(installed, "defaultBranchRef")).toBe(false)
    expect(
      prCommands(installed)
        .find((call) => call.args[1] === "create")!
        .args.slice(4, 8),
    ).toEqual(["--base", "release", "--head", "feature"])
  })

  test("closes name issues of another repository with it, and a bare number means the pull request's", async () => {
    const installed = use(base(stateRule(linkedIssues(rawClosingIssue(3, "other/thing"), rawClosingIssue(4)))))
    await run({ head: "feature", title: "T", body: "B", closes: ["other/thing#3", "#4", "4"], repo: "octo/hello" })
    expect(prCommands(installed).find((call) => call.args[1] === "create")!.stdin).toBe(
      "B\n\nCloses other/thing#3\nCloses #4",
    )
  })

  test("the existing pull request check asks for open ones from head into base", async () => {
    const installed = use(base())
    await run({ head: "feature", title: "T" })
    expect(prCommands(installed)[0]!.args).toEqual([
      "pr",
      "list",
      "--repo",
      "octo/hello",
      "--head",
      "feature",
      "--base",
      "main",
      "--state",
      "open",
      "--json",
      "number,url",
      "--limit",
      "1",
    ])
  })
})

describe("the checks before the pull request is made", () => {
  test("a head that is not on the repository", async () => {
    const installed = use(base(branchRule("octo/hello", "feature", false)))
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('head branch "feature" is not on octo/hello; push it first.')
    expect(prWrites(installed)).toEqual([])
  })

  test("a base that is not on the repository", async () => {
    const installed = use(base(branchRule("octo/hello", "ghost", false)))
    const error = await failure(run({ head: "feature", title: "T", base: "ghost" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('base branch "ghost" is not on octo/hello.')
    expect(prWrites(installed)).toEqual([])
  })

  test("an empty repository has no default base", async () => {
    const installed = use(base(defaultBranchRule(null)))
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("no default branch")
    expect(prWrites(installed)).toEqual([])
  })

  test("a head that is the default branch is the base too", async () => {
    use(base())
    expect((await failure(run({ head: "main", title: "T" }))).code).toBe("invalid_argument")
  })

  test("a pull request from head into base that is open already", async () => {
    const installed = use(
      base({ match: "^pr list", stdout: JSON.stringify([{ number: 3, url: "https://github.com/octo/hello/pull/3" }]) }),
    )
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "octo/hello#3 is already open from feature into main: https://github.com/octo/hello/pull/3. Change it with github_pr_edit.",
    )
    expect(prWrites(installed)).toEqual([])
  })

  test("a milestone that does not exist fails before the pull request is made", async () => {
    const installed = use(base(milestonesRule("v1")))
    const error = await failure(run({ head: "feature", title: "T", milestone: "v9" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("create it first")
    expect(error.message).not.toContain("create_milestone")
    expect(prWrites(installed)).toEqual([])
  })

  test.each([
    ["a blank title", { head: "feature", title: " " }, "title cannot be blank"],
    ["a blank head", { head: " ", title: "T" }, "head cannot be blank"],
    ["a head of a fork", { head: "alice:feature", title: "T" }, "pull requests from forks are not supported yet"],
    ["a head with a colon", { head: "a:b:c", title: "T" }, "head must be a branch of the repository"],
    ["head and base the same", { head: "feature", base: "feature", title: "T" }, "both feature"],
    ["a blank base", { head: "feature", base: " ", title: "T" }, "base is blank"],
    ["a head_sha that is no SHA", { head: "feature", title: "T", head_sha: "abc123" }, "40 hexadecimal"],
    ["a blank milestone", { head: "feature", title: "T", milestone: " " }, "milestone is blank"],
    ["fields without project", { head: "feature", title: "T", fields: { Estimate: 1 } }, "need project"],
    ["a closing reference that is none", { head: "feature", title: "T", closes: ["twelve"] }, "not an issue"],
    ["a list value gh would split", { head: "feature", title: "T", labels: ["a,b"] }, "list syntax"],
  ])("%s is invalid_argument, before any call to GitHub", async (_name, args, expected) => {
    const installed = use(base())
    const error = await failure(run(args))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(sent(installed)).toEqual([])
  })

  test("without write permission it is forbidden, and nothing is written", async () => {
    const installed = use(base(repositoryRule({ permission: "READ" })))
    expect((await failure(run({ head: "feature", title: "T" }))).code).toBe("forbidden")
    expect(prWrites(installed)).toEqual([])
  })
})

describe("head_sha", () => {
  test("a head at that commit is created", async () => {
    const installed = use(base())
    const result = await run({ head: "feature", title: "T", head_sha: HEAD_SHA.toUpperCase() })
    expect(result.errors).toEqual({})
    expect(prWrites(installed)).toHaveLength(1)
  })

  test("a head that moved is stale, and nothing is created", async () => {
    const installed = use(base(branchRule("octo/hello", "feature", true)))
    const error = await failure(run({ head: "feature", title: "T", head_sha: OTHER_SHA }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      `feature on octo/hello is at ${HEAD_SHA.slice(0, 12)}, not ${OTHER_SHA.slice(0, 12)}: the branch moved since it was pushed. Nothing was created.`,
    )
    expect(prWrites(installed)).toEqual([])
    expect(prCommands(installed)).toEqual([])
  })

  test("a head that moves while the pull request is made is told under errors.head_sha, with the actual head", async () => {
    use(base(stateRule({ headRefOid: OTHER_SHA })))
    const result = await run({ head: "feature", title: "T", head_sha: HEAD_SHA })
    expect(result.pr.number).toBe(7)
    expect(result.head_sha).toBe(OTHER_SHA)
    expect(result.errors).toEqual({
      head_sha: `the head moved to ${OTHER_SHA} while the pull request was created`,
    })
  })
})

describe("closing issues and the default branch", () => {
  test("a pull request into another branch says its issues are not linked", async () => {
    use(base(branchRule("octo/hello", "release", true), stateRule({ baseRefName: "release" })))
    const result = await run({ head: "feature", title: "T", base: "release", closes: ["12"] })
    expect(result.notes).toEqual([
      "GitHub links closing issues only for a pull request into the default branch (main); this one is into release, so the issues are named in the body but not linked.",
    ])
  })

  test("GitHub links asynchronously: the closing issues are read again until they are linked, and no longer", async () => {
    // Right after the pull request exists GitHub links nothing yet; a second later it does.
    const installed = use(base(stateRule({}, 1), stateRule(linkedIssues(rawClosingIssue(12)))))
    const started = Date.now()
    const result = await run({ head: "feature", title: "T", closes: ["12"] })
    expect(result.closing_issues.map((issue) => issue.number)).toEqual([12])
    expect(result.notes).toEqual([])
    expect(result.errors).toEqual({})
    expect(sent(installed).filter((args) => new RegExp(STATE).test(args.join(" ")))).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(CLOSING_POLL_TIMEOUT_MS)
  })

  test("an issue not linked when a poll fails is told in a note, and the pull request is still returned", async () => {
    use(base(stateRule({}, 1), { match: STATE, stderr: "boom", code: 1 }))
    const result = await run({ head: "feature", title: "T", closes: ["12"] })
    expect(result.pr.number).toBe(7)
    expect(result.closing_issues).toEqual([])
    expect(result.notes).toEqual([
      "GitHub had not linked octo/hello#12 yet when this call returned; github_pr_read view shows it once it does.",
    ])
  })

  test("a read-back that failed has no closing issues to wait for or to note", async () => {
    use(base({ match: STATE, stderr: "boom", code: 1 }))
    const result = await run({ head: "feature", title: "T", closes: ["12"] })
    expect(result.notes).toEqual([])
    expect(result.errors).toEqual({ read: "github_error: gh failed (exit 1): boom" })
  })

  test("no closes, no note", async () => {
    use(base(branchRule("octo/hello", "release", true)))
    expect((await run({ head: "feature", title: "T", base: "release" })).notes).toEqual([])
  })
})

describe("the steps after the pull request exists", () => {
  test("a read-back that fails is listed, and the pull request is still returned from what is known", async () => {
    use(base({ match: STATE, stderr: "boom", code: 1 }))
    const result = await run({ head: "feature", title: "T", draft: true })
    expect(result).toMatchObject({
      pr: { number: 7, url: URL, title: "T" },
      head_sha: HEAD_SHA,
      draft: true,
      closing_issues: [],
      errors: { read: "github_error: gh failed (exit 1): boom" },
    })
  })

  test("a gh that prints no pull request URL is github_error", async () => {
    use(base({ match: "^pr create", stdout: "created\n" }))
    const error = await failure(run({ head: "feature", title: "T" }))
    expect(error.code).toBe("github_error")
    expect(error.message).toBe(
      "GitHub did not print the pull request it created; look for it before running this again.",
    )
  })

  test("a gh pr create that fails is thrown", async () => {
    use(base({ match: "^pr create", stderr: "HTTP 500", code: 1 }))
    expect((await failure(run({ head: "feature", title: "T" }))).code).toBe("github_error")
  })

  test("a repository of someone else is foreign", async () => {
    use(base(repositoryRule({ viewer: "me" })))
    expect((await run({ head: "feature", title: "T" })).foreign).toBe(true)
  })
})

describe("a board", () => {
  const BOARD = { project: "octo/3" }

  test("the pull request is put on it by its node ID and starts as Todo", async () => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ head: "feature", title: "T", ...BOARD })
    expect(result.project).toEqual({ ...BOARD_SUMMARY, item_id: "PVTI_new", fields: { Status: "Todo" } })
    expect(result.errors).toEqual({})
    const [add, status, ...others] = mutationsOf(installed)
    expect(others).toEqual([])
    expect(add).toMatchObject({ name: "addProjectV2ItemById", vars: { project: "PVT_3", content: "PR_7" } })
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_todo" },
    })
  })

  test("field values are set beside the Todo default, and a Status given replaces it", async () => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ head: "feature", title: "T", ...BOARD, fields: { Estimate: 3 } })
    expect(result.project?.fields).toEqual({ Estimate: 3, Status: "Todo" })
    expect(mutationsOf(installed).map(({ vars }) => vars.field)).toEqual([undefined, "F_estimate", "F_status"])

    const done = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const withStatus = await run({ head: "feature", title: "T", ...BOARD, fields: { status: "done" } })
    expect(withStatus.project?.fields).toEqual({ Status: "Done" })
    expect(mutationsOf(done).map(({ vars }) => vars.value)).toEqual([undefined, "O_done"])
  })

  test("a board step that fails is listed under errors.project, and the pull request is still returned", async () => {
    const installed = use(
      base({ match: "addProjectV2ItemById", stderr: "boom", code: 1 }, ...boardWithFields(), setValueRule()),
    )
    const result = await run({ head: "feature", title: "T", ...BOARD })
    expect(result.pr).toEqual({ number: 7, url: URL, title: "T" })
    expect(result.project).toBeNull()
    expect(result.errors).toEqual({ project: "github_error: gh failed (exit 1): boom" })
    expect(mutationNames(installed)).toEqual(["addProjectV2ItemById"])
  })

  test("a field that fails is listed as fields.<Name>, and the others still land", async () => {
    use(
      base(
        { match: "updateProjectV2ItemFieldValue[\\s\\S]*field=F_estimate", stderr: "boom", code: 1 },
        ...boardWithFields(),
        addItemRule("PVTI_new"),
        setValueRule(),
      ),
    )
    const result = await run({ head: "feature", title: "T", ...BOARD, fields: { Estimate: 1, Notes: "kept" } })
    expect(result.project).toEqual({ ...BOARD_SUMMARY, item_id: "PVTI_new", fields: { Notes: "kept", Status: "Todo" } })
    expect(result.errors).toEqual({ "fields.Estimate": "github_error: gh failed (exit 1): boom" })
  })

  test("a pull request that could not be read back is not put on the board, and says so", async () => {
    const installed = use(
      base({ match: STATE, stderr: "boom", code: 1 }, ...boardWithFields(), addItemRule("PVTI_new"), setValueRule()),
    )
    const result = await run({ head: "feature", title: "T", ...BOARD })
    expect(result.project).toBeNull()
    expect(Object.keys(result.errors).sort()).toEqual(["project", "read"])
    expect(result.errors.project).toContain("github_project_item_add")
    expect(mutationNames(installed)).toEqual([])
  })

  test.each([
    ["an unknown field", { Nope: "x" }, 'no field "Nope"'],
    ["an unknown option", { Status: "Blocked" }, 'no option "Blocked"'],
    ["a bad date", { Target: "tomorrow" }, "YYYY-MM-DD"],
  ])("%s fails before the pull request is made", async (_name, fields, expected) => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const error = await failure(run({ head: "feature", title: "T", ...BOARD, fields }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(prWrites(installed)).toEqual([])
    expect(mutationNames(installed)).toEqual([])
  })

  test("a board the viewer cannot update is forbidden, before the pull request is made", async () => {
    const installed = use(base(...octoBoardRules(3, { viewerCanUpdate: false }), addItemRule("PVTI_new")))
    expect((await failure(run({ head: "feature", title: "T", ...BOARD }))).code).toBe("forbidden")
    expect(prWrites(installed)).toEqual([])
  })
})
