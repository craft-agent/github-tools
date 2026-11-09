import { describe, expect, test } from "bun:test"
import { HEADING } from "../../testing/write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
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
