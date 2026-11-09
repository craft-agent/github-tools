import { describe, expect, test } from "bun:test"
import { PULL_HEADING, pullHeadingRule } from "../../testing/pull-request-write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { DESCRIBE_CASES, REAL_TITLE, describeCase, type DescribeCase } from "./describe.fixtures"

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
    expect(calls.filter((args) => args[0] === "pr" || args.includes("POST"))).toEqual([])
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
