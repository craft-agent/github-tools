import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlReply } from "../../testing/gql"
import { apiCalls, failure, variable } from "../../testing/issue-fixtures"
import { COMMIT_SHA, PULL_HEADING, pullHeadingRule } from "../../testing/pull-request-write-fixtures"
import { parseRepo } from "../refs"
import { readPullRequestHeading } from "./pull-requests"

const CTX = { cwd: process.cwd() }
const REF = { repo: parseRepo("octo/hello"), number: 7 }

let fake: FakeGh | undefined

afterEach(() => {
  fake?.restore()
  fake = undefined
})

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

describe("readPullRequestHeading", () => {
  test("reads the id, the title, the state, the draft flag, the head and the branches in one query", async () => {
    const installed = useFake([
      pullHeadingRule({ id: "PR_9", title: "Fix it", state: "MERGED", isDraft: true, headRefName: "fix" }),
    ])
    expect(await readPullRequestHeading(REF, CTX)).toEqual({
      id: "PR_9",
      title: "Fix it",
      state: "merged",
      draft: true,
      head_sha: COMMIT_SHA,
      base: "main",
      head: "fix",
    })
    expect(apiCalls(installed)).toHaveLength(1)
    expect(variable(apiCalls(installed)[0]!, "n")).toBe("7")
  })

  test("an open pull request is open and not a draft", async () => {
    useFake([pullHeadingRule()])
    expect(await readPullRequestHeading(REF, CTX)).toMatchObject({ state: "open", draft: false })
  })

  test("a pull request that does not exist is not_found", async () => {
    useFake([{ match: PULL_HEADING, stdout: gqlReply({ repository: { pullRequest: null } }) }])
    const error = await failure(readPullRequestHeading(REF, CTX))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#7")
  })
})
