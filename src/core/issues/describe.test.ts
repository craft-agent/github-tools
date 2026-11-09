import { describe, expect, test } from "bun:test"
import { HEAD_SHA } from "../../testing/develop-fixtures"
import { HEADING } from "../../testing/write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { digest } from "../write-facts"
import { DESCRIBE_CASES, REAL_TITLE, describeCase, type DescribeCase } from "./describe.fixtures"

const headline = (text: string, title = REAL_TITLE) => ({ text, values: { title } })
const word = (text: string) => ({ text })

describe("github_issue_comment", () => {
  test("names the issue and shows the comment as written, with no fact for an open issue", async () => {
    expect(await describeCase(DESCRIBE_CASES.comment)).toEqual({
      headline: headline("About to comment on the issue {title}"),
      facts: [],
      text: { label: "Comment", body: "Thanks!" },
    })
  })

  test("flags a closed issue as closed", async () => {
    const description = await describeCase(DESCRIBE_CASES.commentOnClosed)
    expect(description?.facts).toEqual([{ label: "State", value: word("Closed") }])
  })
})

describe("github_issue_close", () => {
  test("shows the reason and the comment that goes with the close, trimmed as it is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.closeCompleted)).toEqual({
      headline: headline("About to close the issue {title}"),
      facts: [{ label: "Reason", value: word("Completed") }],
      text: { label: "Comment", body: "Shipped in v2." },
    })
  })

  test("words each reason", async () => {
    const description = await describeCase(DESCRIBE_CASES.closeNotPlanned)
    expect(description?.facts).toEqual([{ label: "Reason", value: word("Not planned") }])
    expect(description?.text).toBeUndefined()
  })

  test("names the original of a duplicate as owner/repo#N, in the issue's repository for a bare number", async () => {
    const description = await describeCase(DESCRIBE_CASES.closeDuplicate)
    expect(description?.facts).toEqual([
      { label: "Reason", value: word("Duplicate") },
      { label: "Duplicate of", value: "octo/hello#5" },
    ])
    const elsewhere = await describeCase(DESCRIBE_CASES.closeDuplicateElsewhere)
    expect(elsewhere?.facts.at(-1)).toEqual({ label: "Duplicate of", value: "other/thing#7" })
  })

  test("says nothing is sent for an issue that is closed already, and shows no comment", async () => {
    expect(await describeCase(DESCRIBE_CASES.closeClosed)).toEqual({
      headline: headline("About to close the issue {title}"),
      facts: [{ label: "State", value: word("Already closed; nothing is sent") }],
    })
  })
})

describe("github_issue_reopen", () => {
  test("shows the comment that goes with the reopening, with no facts", async () => {
    expect(await describeCase(DESCRIBE_CASES.reopen)).toEqual({
      headline: headline("About to reopen the issue {title}"),
      facts: [],
      text: { label: "Comment", body: "Still happens." },
    })
  })

  test("says nothing is sent for an issue that is open already, and shows no comment", async () => {
    expect(await describeCase(DESCRIBE_CASES.reopenOpen)).toEqual({
      headline: headline("About to reopen the issue {title}"),
      facts: [{ label: "State", value: word("Already open; nothing is sent") }],
    })
  })
})

describe("github_issue_edit", () => {
  test("lists each change, shows the replacing body, pins the body it replaces and names the issue by its real title", async () => {
    expect(await describeCase(DESCRIBE_CASES.editReplacing)).toEqual({
      headline: headline("About to edit the issue {title}"),
      facts: [
        { label: "Title", value: "Not the real title" },
        { label: "Body", value: word("Replaced") },
        { label: "Labels", value: "+bug +docs \u2212wontfix" },
        { label: "Assignees", value: "+@me" },
      ],
      text: { label: "New body", body: "Fresh body" },
      pins: { body: digest("Old body") },
    })
  })

  test("a body that clears has no text, and a removed milestone and assignee are facts", async () => {
    expect(await describeCase(DESCRIBE_CASES.editClearing)).toEqual({
      headline: headline("About to edit the issue {title}"),
      facts: [
        { label: "Body", value: word("Cleared") },
        { label: "Assignees", value: "\u2212bob" },
        { label: "Milestone", value: word("Removed") },
      ],
      pins: { body: digest("Old body") },
    })
  })

  test("an appended text is shown as appended, pins nothing, and a new milestone says it is new", async () => {
    expect(await describeCase(DESCRIBE_CASES.editAppending)).toEqual({
      headline: headline("About to edit the issue {title}"),
      facts: [
        { label: "Body", value: word("Appended") },
        { label: "Milestone", value: { text: "{name} (new)", values: { name: "v2" } } },
        { label: "Kind", value: "bug" },
        { label: "Issue fields", value: "+Priority \u2212Sprint" },
      ],
      text: { label: "Appended text", body: "More details." },
    })
  })

  test("a milestone that exists is shown by its title as the repository has it", async () => {
    const description = await describeCase(DESCRIBE_CASES.editMilestone)
    expect(description?.facts).toEqual([{ label: "Milestone", value: "v1" }])
  })

  test("a milestone that does not exist, without create_milestone, gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.editMilestone, args: { issue: "12", milestone: "v9" } }
    expect(await describeCase(item)).toBeUndefined()
  })

  test("an edit that changes nothing gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.editMilestone, args: { issue: "12" } }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_issue_create", () => {
  test("a title alone gives the headline with the title the issue will have", async () => {
    expect(await describeCase(DESCRIBE_CASES.createPlain)).toEqual({
      headline: headline("About to create the issue {title}", "Add retry"),
      facts: [],
    })
  })

  test("every optional piece is a fact, in the order of what decides, and the body is the text", async () => {
    expect(await describeCase(DESCRIBE_CASES.createFull)).toEqual({
      headline: headline("About to create the issue {title}", "Add retry"),
      facts: [
        { label: "Labels", value: "+bug +docs" },
        { label: "Assignees", value: "+alice" },
        { label: "Kind", value: "bug" },
        { label: "Milestone", value: "v1" },
        { label: "Parent", value: "octo/hello#5" },
        { label: "Blocked by", value: "+octo/hello#6 +other/thing#7" },
        { label: "Issue fields", value: "+Priority" },
        { label: "Board", value: "Roadmap" },
      ],
      text: { label: "Issue body", body: "Retry three times." },
    })
  })

  test("a milestone the call makes says it is new", async () => {
    const description = await describeCase(DESCRIBE_CASES.createNewMilestone)
    expect(description?.facts).toEqual([
      { label: "Milestone", value: { text: "{name} (new)", values: { name: "v9" } } },
    ])
  })

  test("a blank title gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.createPlain, args: { title: "  " } }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_issue_relate", () => {
  test("one fact per relation, with the issues as owner/repo#N, added before removed", async () => {
    expect(await describeCase(DESCRIBE_CASES.relate)).toEqual({
      headline: headline("About to change the relations of the issue {title}"),
      facts: [
        { label: "Parent", value: "octo/hello#1" },
        { label: "Sub-issues", value: "+octo/hello#13 +octo/other#2 \u2212octo/hello#14" },
        { label: "Blocked by", value: "+octo/hello#5" },
        { label: "Blocking", value: "\u2212octo/hello#7" },
      ],
    })
  })

  test("taking the issue out of its parent is a fact", async () => {
    const description = await describeCase(DESCRIBE_CASES.relateRemovingParent)
    expect(description?.facts).toEqual([
      { label: "Parent", value: word("Removed") },
      { label: "Blocking", value: "+octo/hello#8" },
    ])
  })

  test("an issue related to itself gives no description", async () => {
    const item: DescribeCase = { ...DESCRIBE_CASES.relate, args: { issue: "12", parent: "12" } }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("github_issue_develop", () => {
  test("a branch GitHub names is shown with its base, and the base's head commit is pinned", async () => {
    expect(await describeCase(DESCRIBE_CASES.developCreating)).toEqual({
      headline: headline("About to link a development branch to the issue {title}"),
      facts: [
        { label: "Branch", value: word("Named by GitHub") },
        { label: "Base", value: "main" },
      ],
      pins: { base_head: HEAD_SHA },
    })
  })

  test("a named branch and base are shown as given", async () => {
    const description = await describeCase(DESCRIBE_CASES.developNamed)
    expect(description?.facts).toEqual([
      { label: "Branch", value: "12-fix" },
      { label: "Base", value: "release/1.x" },
    ])
    expect(description?.pins).toEqual({ base_head: HEAD_SHA })
  })

  test("a branch that is linked already is reused: no base and no pin", async () => {
    expect(await describeCase(DESCRIBE_CASES.developReusing)).toEqual({
      headline: headline("About to link a development branch to the issue {title}"),
      facts: [{ label: "Branch", value: { text: "{name} (already linked)", values: { name: "12-crash" } } }],
    })
  })

  test("a base branch that does not exist gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.developNamed,
      rules: [
        ...DESCRIBE_CASES.developNamed.rules.slice(0, 2),
        { match: "^api repos", stderr: "Not Found (HTTP 404)", code: 1 },
      ],
    }
    expect(await describeCase(item)).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values(DESCRIBE_CASES)

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
    expect(calls.filter((args) => args[0] === "issue" || args.includes("POST"))).toEqual([])
  })

  test("a failing read gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.closeCompleted,
      rules: [{ match: HEADING, stderr: "HTTP 500", code: 1 }],
    }
    expect(await describeCase(item)).toBeUndefined()
  })

  test("an issue that does not exist gives no description", async () => {
    const item: DescribeCase = {
      ...DESCRIBE_CASES.comment,
      rules: [{ match: HEADING, stdout: JSON.stringify({ data: { repository: { issue: null } } }) }],
    }
    expect(await describeCase(item)).toBeUndefined()
  })
})
