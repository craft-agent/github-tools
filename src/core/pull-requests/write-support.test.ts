import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { failure } from "../../testing/issue-fixtures"
import { pullHeadingRule } from "../../testing/pull-request-write-fixtures"
import { ORIGIN } from "../../testing/write-fixtures"
import { describedPull } from "./write-support"

let fake: FakeGh | undefined

afterEach(() => {
  fake?.restore()
  fake = undefined
})

describe("describedPull", () => {
  test("a bare number names the working tree's repository, and the heading is read from GitHub", async () => {
    const repo = tempRepo(ORIGIN)
    fake = installFakeGh([pullHeadingRule({ title: "Real title" })])
    try {
      const { ref, heading } = await describedPull({ pr: "#7" }, { cwd: repo.dir })
      expect(ref.repo.full).toBe("octo/hello")
      expect(ref.number).toBe(7)
      expect(heading).toMatchObject({ id: "PR_7", title: "Real title", state: "open" })
    } finally {
      repo.cleanup()
    }
  })

  test("a pull request URL names its own repository", async () => {
    fake = installFakeGh([pullHeadingRule()])
    const { ref } = await describedPull({ pr: "https://github.com/other/thing/pull/7" }, { cwd: process.cwd() })
    expect(ref.repo.full).toBe("other/thing")
    expect(ref.number).toBe(7)
  })

  test("an issue URL is refused, as the tools refuse it", async () => {
    fake = installFakeGh([pullHeadingRule()])
    const error = await failure(describedPull({ pr: "https://github.com/octo/hello/issues/7" }, { cwd: process.cwd() }))
    expect(error.code).toBe("invalid_argument")
  })
})
