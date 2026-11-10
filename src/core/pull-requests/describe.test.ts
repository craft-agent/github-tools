import { describe, expect, test } from "bun:test"
import { HEAD_SHA, branchRule } from "../../testing/develop-fixtures"
import { headSha, mergeStateRule, mergedState, methodsRule } from "../../testing/merge-fixtures"
import { COMMIT_SHA, PULL_HEADING, pullHeadingRule, stateRule } from "../../testing/pull-request-write-fixtures"
import { chainRules, inStack, pullRule, rawFullStack, stackFailureRule, stackRule } from "../../testing/stack-fixtures"
import { milestonesRule } from "../../testing/write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { shortSha } from "../refs"
import { digest } from "../write-facts"
import {
  DESCRIBE_CASES,
  REAL_TITLE,
  createRules,
  describeCase,
  mergeRules,
  reviewRules,
  stackRules,
  type DescribeCase,
} from "./describe.fixtures"

/** The methods of a `gh api` call that change something: a review is a POST, a merge a PUT, a branch deletion a DELETE. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

const headline = (text: string, title = REAL_TITLE) => ({ text, values: { title } })
const word = (text: string) => ({ text })

describe("github_pr_comment", () => {
  test("names the pull request and shows the comment as written, with no fact for an open one", async () => {
    expect(await describeCase(DESCRIBE_CASES.comment)).toEqual({
      headline: headline("About to comment on the pull request {title}"),
      facts: [],
      text: { label: "Comment", body: "Looks good." },
    })
  })

  test("flags a merged or closed pull request", async () => {
    const merged = await describeCase(DESCRIBE_CASES.commentOnMerged)
    expect(merged?.facts).toEqual([{ label: "State", value: word("Merged") }])
    const closed = await describeCase(DESCRIBE_CASES.commentOnClosed)
    expect(closed?.facts).toEqual([{ label: "State", value: word("Closed") }])
  })

  test("lists the base name of each attachment, in the order given", async () => {
    expect(await describeCase(DESCRIBE_CASES.commentAttaching)).toEqual({
      headline: headline("About to comment on the pull request {title}"),
      facts: [{ label: "Attachments", value: "screen.png, demo.mp4" }],
      text: { label: "Comment", body: "See ![the screen](./screen.png)." },
    })
  })

  test("a blank comment gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.comment, args: { pr: "7", body: "  " } }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_pr_close", () => {
  test("shows the comment that goes with the close, trimmed as it is sent, and no fact", async () => {
    expect(await describeCase(DESCRIBE_CASES.close)).toEqual({
      headline: headline("About to close the pull request {title}"),
      facts: [],
      text: { label: "Comment", body: "Superseded by #9." },
    })
  })

  test("without a comment there is no text", async () => {
    const description = await describeCase(DESCRIBE_CASES.closeBare)
    expect(description?.facts).toEqual([])
    expect(description?.text).toBeUndefined()
  })

  test("says nothing is sent for a pull request that is closed already, and shows no comment", async () => {
    expect(await describeCase(DESCRIBE_CASES.closeClosed)).toEqual({
      headline: headline("About to close the pull request {title}"),
      facts: [{ label: "State", value: word("Already closed; nothing is sent") }],
    })
  })

  test("says nothing is sent for a pull request that is merged already", async () => {
    expect(await describeCase(DESCRIBE_CASES.closeMerged)).toEqual({
      headline: headline("About to close the pull request {title}"),
      facts: [{ label: "State", value: word("Already merged; nothing is sent") }],
    })
  })
})

describe("github_pr_reopen", () => {
  test("shows the comment that goes with the reopening, with no facts", async () => {
    expect(await describeCase(DESCRIBE_CASES.reopen)).toEqual({
      headline: headline("About to reopen the pull request {title}"),
      facts: [],
      text: { label: "Comment", body: "Still needed." },
    })
  })

  test("says nothing is sent for a pull request that is open already, and shows no comment", async () => {
    expect(await describeCase(DESCRIBE_CASES.reopenOpen)).toEqual({
      headline: headline("About to reopen the pull request {title}"),
      facts: [{ label: "State", value: word("Already open; nothing is sent") }],
    })
  })

  test("a merged pull request gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.reopen, rules: [pullHeadingRule({ state: "MERGED" })] }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_pr_ready", () => {
  test("marking a draft ready has no facts and no text", async () => {
    expect(await describeCase(DESCRIBE_CASES.readyDraft)).toEqual({
      headline: headline("About to mark the pull request {title} as ready for review"),
      facts: [],
    })
  })

  test("a pull request that is ready already says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.readyReady)).toEqual({
      headline: headline("About to mark the pull request {title} as ready for review"),
      facts: [{ label: "State", value: word("Already ready; nothing is sent") }],
    })
  })

  test("undo turns a ready pull request back into a draft", async () => {
    expect(await describeCase(DESCRIBE_CASES.readyUndo)).toEqual({
      headline: headline("About to turn the pull request {title} back into a draft"),
      facts: [],
    })
  })

  test("undo on a draft says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.readyUndoDraft)).toEqual({
      headline: headline("About to turn the pull request {title} back into a draft"),
      facts: [{ label: "State", value: word("Already a draft; nothing is sent") }],
    })
  })

  test("a closed or merged pull request gives no description", async () => {
    for (const state of ["CLOSED", "MERGED"]) {
      const item: DescribeCase = { ...DESCRIBE_CASES.readyDraft, rules: [pullHeadingRule({ state, isDraft: true })] }
      expect(await describeCase(item)).toBeUndefined()
    }
  })
})

describe("github_pr_edit", () => {
  test("lists each change, shows the replacing body, pins the body it replaces and names the pull request by its real title", async () => {
    expect(await describeCase(DESCRIBE_CASES.editReplacing)).toEqual({
      headline: headline("About to edit the pull request {title}"),
      facts: [
        { label: "Title", value: "Not the real title" },
        { label: "Body", value: word("Replaced") },
        { label: "Reviewers", value: "+dave +octo/core" },
        { label: "Labels", value: "+bug +docs \u2212wontfix" },
      ],
      text: { label: "New body", body: "Fresh body" },
      pins: { body: digest("Old body") },
    })
  })

  test("a body that clears has no text, and a removed milestone and assignee are facts", async () => {
    expect(await describeCase(DESCRIBE_CASES.editClearing)).toEqual({
      headline: headline("About to edit the pull request {title}"),
      facts: [
        { label: "Body", value: word("Cleared") },
        { label: "Assignees", value: "\u2212bob" },
        { label: "Milestone", value: word("Removed") },
      ],
      pins: { body: digest("Old body") },
    })
  })

  test("an appended text is shown as appended and pins nothing; a milestone is shown as the repository has it; attachments are listed", async () => {
    expect(await describeCase(DESCRIBE_CASES.editAppending)).toEqual({
      headline: headline("About to edit the pull request {title}"),
      facts: [
        { label: "Body", value: word("Appended") },
        { label: "Assignees", value: "+@me" },
        { label: "Milestone", value: "v1" },
        { label: "Attachments", value: "screen.png, demo.mp4" },
      ],
      text: { label: "Appended text", body: "More details." },
    })
  })

  test("a retarget comes first, and the closing issues added and removed are resolved as owner/repo#N", async () => {
    expect(await describeCase(DESCRIBE_CASES.editRetargeting)).toEqual({
      headline: headline("About to edit the pull request {title}"),
      facts: [
        { label: "Base", value: "release" },
        { label: "Title", value: "Retarget" },
        { label: "Closes", value: "+octo/hello#12 +other/thing#3 \u2212octo/hello#5" },
      ],
    })
  })

  test("a merged pull request can still be retitled", async () => {
    const description = await describeCase(DESCRIBE_CASES.editMerged)
    expect(description?.facts).toEqual([{ label: "Title", value: "Renamed" }])
  })

  test.each([
    ["a merged pull request cannot be retargeted", "release", "MERGED", true],
    ["the head branch cannot be the base", "feature", "OPEN", true],
    ["a base branch that does not exist", "nowhere", "OPEN", false],
  ])("%s: no description", async (_name, base, state, exists) => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.editRetargeting,
      args: { pr: "7", base },
      rules: [pullHeadingRule({ state }), branchRule("octo/hello", base, exists)],
    }
    expect(await describeCase(item)).toBeUndefined()
  })

  test.each([
    ["nothing to change", { pr: "7" }],
    ["a body and an appended text", { pr: "7", body: "a", append_body: "b" }],
    ["a blank title", { pr: "7", title: " " }],
    ["a label both added and removed", { pr: "7", add_labels: ["bug"], remove_labels: ["Bug"] }],
    ["a closing issue both added and removed", { pr: "7", add_closes: ["5"], remove_closes: ["#5"] }],
  ])("%s: no description", async (_name, args) => {
    const item: DescribeCase = { ...DESCRIBE_CASES.editReplacing, args }
    expect(await describeCase(item)).toBeUndefined()
  })

  test("a milestone that does not exist gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.editAppending, args: { pr: "7", milestone: "v9" } }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_pr_create", () => {
  test("a head and a title give the call's own title, the branches and a pin on the head commit", async () => {
    expect(await describeCase(DESCRIBE_CASES.createPlain)).toEqual({
      headline: headline("About to create the pull request {title}", "Add retry"),
      facts: [
        { label: "Base", value: "main" },
        { label: "Head", value: "feature" },
      ],
      pins: { head_sha: HEAD_SHA },
    })
  })

  test("every optional piece is a fact, in the order of what decides, and the body is the text", async () => {
    expect(await describeCase(DESCRIBE_CASES.createFull)).toEqual({
      headline: headline("About to create the pull request {title}", "Add retry"),
      facts: [
        { label: "Base", value: "release" },
        { label: "Head", value: "feature" },
        { label: "State", value: word("Draft") },
        { label: "Closes", value: "+octo/hello#12 +other/thing#7" },
        { label: "Labels", value: "+bug +docs" },
        { label: "Milestone", value: "v1" },
        { label: "Attachments", value: "screen.png, demo.mp4" },
        { label: "Board", value: "Roadmap" },
      ],
      text: { label: "Pull request body", body: "Retry three times." },
      pins: { head_sha: HEAD_SHA },
    })
  })

  test("reviewers, labels and assignees are changes to add", async () => {
    const description = await describeCase(DESCRIBE_CASES.createPeople)
    expect(description?.facts.slice(2)).toEqual([
      { label: "Reviewers", value: "+dave +octo/core" },
      { label: "Labels", value: "+bug" },
      { label: "Assignees", value: "+alice" },
    ])
  })

  test.each([
    ["a blank title", { head: "feature", title: " " }, createRules()],
    ["a blank head", { head: " ", title: "T" }, createRules()],
    ["a head of a fork", { head: "someone:feature", title: "T" }, createRules()],
    ["the same head and base", { head: "feature", base: "feature", title: "T" }, createRules()],
    ["a head_sha that is not a full SHA", { head: "feature", title: "T", head_sha: "abc" }, createRules()],
    ["a head_sha the branch moved from", { head: "feature", title: "T", head_sha: "f".repeat(40) }, createRules()],
    ["fields without a project", { head: "feature", title: "T", fields: { Target: "x" } }, createRules()],
    ["a head branch that does not exist", { head: "gone", title: "T" }, createRules()],
    ["a base branch that does not exist", { head: "feature", base: "gone", title: "T" }, createRules()],
    [
      "a milestone that does not exist",
      { head: "feature", title: "T", milestone: "v9" },
      createRules(milestonesRule("v1")),
    ],
    [
      "a pull request open already from head into base",
      { head: "feature", title: "T" },
      [{ match: "^pr list", stdout: '[{"number":3,"url":"https://github.com/octo/hello/pull/3"}]' }, ...createRules()],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.createPlain, args, rules })).toBeUndefined()
  })
})

describe("github_pr_review", () => {
  const commit = { label: "Commit", value: shortSha(COMMIT_SHA) }

  test("approving names the commit it is posted on, shows the body trimmed as it is sent and pins the full commit", async () => {
    expect(await describeCase(DESCRIBE_CASES.reviewApprove)).toEqual({
      headline: headline("About to approve the pull request {title}"),
      facts: [commit],
      text: { label: "Review", body: "Ship it." },
      pins: { head_sha: COMMIT_SHA },
    })
  })

  test("an approval without a body has no text", async () => {
    expect(await describeCase(DESCRIBE_CASES.reviewApproveBare)).toEqual({
      headline: headline("About to approve the pull request {title}"),
      facts: [commit],
      pins: { head_sha: COMMIT_SHA },
    })
  })

  test("requesting changes shows the body", async () => {
    expect(await describeCase(DESCRIBE_CASES.reviewRequestChanges)).toEqual({
      headline: headline("About to request changes on the pull request {title}"),
      facts: [commit],
      text: { label: "Review", body: "Needs a test." },
      pins: { head_sha: COMMIT_SHA },
    })
  })

  test("line comments are counted, and written after the body, each under its place, in the order given", async () => {
    expect(await describeCase(DESCRIBE_CASES.reviewComments)).toEqual({
      headline: headline("About to review the pull request {title} with comments"),
      facts: [commit, { label: "Line comments", value: { text: "{count} comments", values: { count: 2 } } }],
      text: {
        label: "Review",
        body: "A few notes.\n\nsrc/a.ts:12\nWhy this?\n\nsrc/b.ts:3-9 (left)\nRemove this block.",
      },
      pins: { head_sha: COMMIT_SHA },
    })
  })

  test("one line comment is counted in the singular, and alone it is the whole text", async () => {
    const description = await describeCase(DESCRIBE_CASES.reviewOneComment)
    expect(description?.facts[1]).toEqual({
      label: "Line comments",
      value: { text: "{count} comment", values: { count: 1 } },
    })
    expect(description?.text).toEqual({ label: "Review", body: "src/a.ts:12\nNit." })
  })

  test("the pin is the head commit the pull request is at now", async () => {
    const moved = "9".repeat(40)
    const item: DescribeCase = {
      ...DESCRIBE_CASES.reviewApprove,
      rules: reviewRules(pullHeadingRule({ headRefOid: moved })),
    }
    expect((await describeCase(item))?.pins).toEqual({ head_sha: moved })
  })

  test("a comment review is allowed on a closed pull request, and a head_sha in the other case still matches", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.reviewComments,
      args: { ...DESCRIBE_CASES.reviewComments.args, head_sha: COMMIT_SHA.toUpperCase() },
      rules: [pullHeadingRule({ state: "CLOSED" })],
    }
    expect(await describeCase(item)).toBeDefined()
  })

  const approving = DESCRIBE_CASES.reviewApprove
  test.each([
    ["request_changes without a body", { pr: "7", event: "request_changes", body: " " }, approving.rules],
    ["a comment review with nothing in it", { pr: "7", event: "comment" }, approving.rules],
    [
      "a line comment without a path",
      { pr: "7", event: "comment", comments: [{ path: " ", line: 1, body: "x" }] },
      approving.rules,
    ],
    [
      "a line comment without a body",
      { pr: "7", event: "comment", comments: [{ path: "a.ts", line: 1, body: " " }] },
      approving.rules,
    ],
    [
      "a range that does not start before its end",
      { pr: "7", event: "comment", comments: [{ path: "a.ts", start_line: 4, line: 4, body: "x" }] },
      approving.rules,
    ],
    ["a head_sha that is not a full SHA", { pr: "7", event: "approve", head_sha: "abc" }, approving.rules],
    [
      "a head_sha the pull request moved from",
      { pr: "7", event: "approve", head_sha: "f".repeat(40) },
      approving.rules,
    ],
    [
      "approving a closed pull request",
      { pr: "7", event: "approve" },
      reviewRules(pullHeadingRule({ state: "CLOSED" })),
    ],
    [
      "requesting changes on a merged pull request",
      { pr: "7", event: "request_changes", body: "x" },
      reviewRules(pullHeadingRule({ state: "MERGED" })),
    ],
    [
      "approving one's own pull request",
      { pr: "7", event: "approve" },
      reviewRules(stateRule({ author: { login: "ALICE" } })),
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...approving, args, rules })).toBeUndefined()
  })
})

describe("github_pr_merge", () => {
  const method = (text: string) => ({ label: "Method", value: word(text) })

  test("a merge commit gives its method and pins the head commit, with no text", async () => {
    expect(await describeCase(DESCRIBE_CASES.mergeCommit)).toEqual({
      headline: headline("About to merge the pull request {title}"),
      facts: [method("Merge commit")],
      pins: { head_sha: headSha(7) },
    })
  })

  test("a squash lists the open issues it closes, in any repository, the branch it deletes and the commit message it sets", async () => {
    expect(await describeCase(DESCRIBE_CASES.mergeSquash)).toEqual({
      headline: headline("About to merge the pull request {title}"),
      facts: [
        method("Squash"),
        { label: "Closes", value: "octo/hello#12 other/thing#3" },
        { label: "Branch", value: word("Deleted after merge") },
      ],
      text: { label: "Merge commit message", body: "Add retry (#7)\n\nRetries three times." },
      pins: { head_sha: headSha(7) },
    })
  })

  test("a rebase gives its method", async () => {
    expect((await describeCase(DESCRIBE_CASES.mergeRebase))?.facts).toEqual([method("Rebase")])
  })

  test("the method is the one the repository allows when none is asked", async () => {
    expect((await describeCase(DESCRIBE_CASES.mergeOnlyMethod))?.facts).toEqual([method("Squash")])
  })

  test.each([
    ["a subject alone", { pr: "7", method: "merge", subject: "Title" }, "Title"],
    ["a body alone", { pr: "7", method: "squash", body: " Details. " }, "Details."],
  ])("%s is the commit message", async (_name, args, body) => {
    const item: DescribeCase = { ...DESCRIBE_CASES.mergeCommit, args }
    expect((await describeCase(item))?.text).toEqual({ label: "Merge commit message", body })
  })

  test("a stack names the layers below it that go along and pins each of them", async () => {
    expect(await describeCase(DESCRIBE_CASES.mergeStack)).toEqual({
      headline: headline("About to merge the pull request {title}"),
      facts: [method("Squash"), { label: "Also merges", value: "#3 #4" }],
      pins: { head_sha: headSha(5), lower_layers: digest(`#3@${headSha(3)}\n#4@${headSha(4)}`) },
    })
  })

  test("a lower layer that moved changes the pin of the layers, not the pin of the head", async () => {
    const moved = "c".repeat(40)
    const item: DescribeCase = {
      ...DESCRIBE_CASES.mergeStack,
      rules: mergeRules(...stackRules({ 4: { headRefOid: moved } })),
    }
    expect((await describeCase(item))?.pins).toEqual({
      head_sha: headSha(5),
      lower_layers: digest(`#3@${headSha(3)}\n#4@${moved}`),
    })
  })

  test("a layer below that is merged already does not go along", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.mergeStack,
      rules: mergeRules(...stackRules({ 3: mergedState(3) })),
    }
    const description = await describeCase(item)
    expect(description?.facts[1]).toEqual({ label: "Also merges", value: "#4" })
    expect(description?.pins).toEqual({ head_sha: headSha(5), lower_layers: digest(`#4@${headSha(4)}`) })
  })

  test("with_lower_layers on a pull request with nothing below it adds no fact and no pin", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.mergeCommit,
      args: { pr: "7", method: "merge", with_lower_layers: true },
    }
    const description = await describeCase(item)
    expect(description?.facts).toEqual([method("Merge commit")])
    expect(description?.pins).toEqual({ head_sha: headSha(7) })
  })

  test("a pull request that is merged already says nothing is sent, and pins nothing", async () => {
    expect(await describeCase(DESCRIBE_CASES.mergeMerged)).toEqual({
      headline: headline("About to merge the pull request {title}"),
      facts: [{ label: "State", value: word("Already merged; nothing is sent") }],
    })
  })

  test("a head_sha in the other case still matches", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.mergeCommit,
      args: { pr: "7", method: "merge", head_sha: headSha(7).toUpperCase() },
    }
    expect(await describeCase(item)).toBeDefined()
  })

  const merging = DESCRIBE_CASES.mergeCommit
  test.each([
    ["a closed pull request", { pr: "7", method: "merge" }, mergeRules(mergeStateRule(7, { state: "CLOSED" }))],
    ["a draft", { pr: "7", method: "merge" }, mergeRules(mergeStateRule(7, { isDraft: true }))],
    ["conflicts", { pr: "7", method: "merge" }, mergeRules(mergeStateRule(7, { mergeable: "CONFLICTING" }))],
    ["a dirty merge state", { pr: "7", method: "merge" }, mergeRules(mergeStateRule(7, { mergeStateStatus: "DIRTY" }))],
    ["a head_sha that is not a full SHA", { pr: "7", method: "merge", head_sha: "abc" }, merging.rules],
    ["a head_sha the pull request moved from", { pr: "7", method: "merge", head_sha: "f".repeat(40) }, merging.rules],
    ["a rebase with a subject", { pr: "7", method: "rebase", subject: "Title" }, merging.rules],
    ["a rebase with a body", { pr: "7", method: "rebase", body: "Details" }, merging.rules],
    ["a method the repository does not allow", { pr: "7", method: "merge" }, mergeRules(methodsRule("squash"))],
    ["several methods and none asked", { pr: "7" }, merging.rules],
    ["no method allowed", { pr: "7", method: "merge" }, mergeRules(methodsRule())],
    [
      "the only allowed method being a rebase, with a subject",
      { pr: "7", subject: "Title" },
      mergeRules(methodsRule("rebase")),
    ],
    ["layers below without with_lower_layers", { pr: "5", method: "squash" }, mergeRules(...stackRules())],
    [
      "a lower layer that is a draft",
      { pr: "5", method: "squash", with_lower_layers: true },
      mergeRules(...stackRules({ 3: { isDraft: true } })),
    ],
    [
      "a lower layer in conflict",
      { pr: "5", method: "squash", with_lower_layers: true },
      mergeRules(...stackRules({ 4: { mergeable: "CONFLICTING" } })),
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...merging, args, rules })).toBeUndefined()
  })
})

describe("github_stack_link", () => {
  const onMain = { text: "About to link the pull requests into a stack on {base}", values: { base: "main" } }

  test("a new stack names the trunk, lists the layers bottom to top with their real titles and says it is new", async () => {
    expect(await describeCase(DESCRIBE_CASES.linkNew)).toEqual({
      headline: onMain,
      facts: [
        { label: "Layers", value: "#3 Add retry, #4 Use it" },
        { label: "Stack", value: word("New stack") },
      ],
    })
  })

  test("layers on top of an existing stack list the whole stack and count what it holds", async () => {
    expect(await describeCase(DESCRIBE_CASES.linkExtending)).toEqual({
      headline: onMain,
      facts: [
        { label: "Layers", value: "#101 Pull request 101, #102 Pull request 102, #103 Third layer" },
        { label: "Stack", value: { text: "Extends a stack of {count}", values: { count: 2 } } },
      ],
    })
  })

  test("pull requests that are in the stack already say nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.linkAlready)).toEqual({
      headline: onMain,
      facts: [{ label: "State", value: word("Already linked; nothing is sent") }],
    })
  })

  test.each([
    ["a pull request listed twice", { prs: [3, 3] }, DESCRIBE_CASES.linkNew.rules],
    ["a new stack of one", { prs: [3] }, DESCRIBE_CASES.linkNew.rules],
    ["a pull request that is closed", { prs: [3, 4] }, [...chainRules([3, 4], { 4: { state: "closed" } })]],
    ["a chain whose bases do not match", { prs: [3, 4] }, [pullRule(3, null), pullRule(4, 9)]],
    [
      "a head branch in a fork",
      { prs: [3, 4] },
      chainRules([3, 4], { 4: { head: { ref: "feature-4", sha: "sha-4", repo: { full_name: "fork/hello" } } } }),
    ],
    ["pull requests of two stacks", { prs: [3, 4] }, chainRules([3, 4], { 3: inStack(5, 1, 1), 4: inStack(6, 1, 1) })],
    [
      "a list that is not the top of the stack",
      { prs: [101, 103] },
      [...chainRules([101], { 101: inStack(5, 1, 2) }), pullRule(103, 101), stackRule(5, rawFullStack(5, [101, 102]))],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.linkNew, args, rules })).toBeUndefined()
  })
})

describe("github_stack_unlink", () => {
  const out = { text: "About to take the pull requests out of the stack" }

  test("a stack named by its number lists its layers bottom to top", async () => {
    expect(await describeCase(DESCRIBE_CASES.unlinkByStack)).toEqual({
      headline: out,
      facts: [{ label: "Layers", value: "#101 Pull request 101, #102 Pull request 102, #103 Pull request 103" }],
    })
  })

  test("a pull request names the stack it is in", async () => {
    const description = await describeCase(DESCRIBE_CASES.unlinkByPull)
    expect(description?.facts).toEqual([
      { label: "Layers", value: "#101 Pull request 101, #102 Pull request 102, #103 Pull request 103" },
    ])
  })

  test("a merged layer is not listed, and the fact says it stays", async () => {
    expect(await describeCase(DESCRIBE_CASES.unlinkWithMerged)).toEqual({
      headline: out,
      facts: [
        { label: "Layers", value: "#102 Pull request 102, #103 Pull request 103" },
        { label: "Stays", value: word("Merged and queued layers stay") },
      ],
    })
  })

  test("a stack of merged layers only says no layer can leave", async () => {
    expect((await describeCase(DESCRIBE_CASES.unlinkAllMerged))?.facts).toEqual([
      { label: "State", value: word("No layer can leave; nothing is sent") },
    ])
  })

  test("a pull request in no stack says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.unlinkInNone)).toEqual({
      headline: out,
      facts: [{ label: "State", value: word("In no stack; nothing is sent") }],
    })
  })

  test.each([
    ["neither a stack nor a pull request", {}, DESCRIBE_CASES.unlinkByStack.rules],
    ["both a stack and a pull request", { stack: 5, pr: "102" }, DESCRIBE_CASES.unlinkByStack.rules],
    [
      "a stack that does not exist",
      { stack: 9 },
      [stackFailureRule("repos/octo/hello/stacks/9$", "HTTP 404 Not Found")],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.unlinkByStack, args, rules })).toBeUndefined()
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
      (args[0] === "pr" && args[1] !== "list") || WRITE_METHODS.some((method) => args.includes(method))
    expect(calls.filter(isWrite)).toEqual([])
  })

  test("a failing read gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.close,
      rules: [{ match: PULL_HEADING, stderr: "HTTP 500", code: 1 }],
    }
    expect(await describeCase(item)).toBeUndefined()
  })

  test("a pull request that does not exist gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.comment,
      rules: [{ match: PULL_HEADING, stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) }],
    }
    expect(await describeCase(item)).toBeUndefined()
  })
})
