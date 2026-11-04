import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { parseRepo } from "../refs"
import { ghIssueRef, issueLabel, resolveRelatedIssue } from "./issue-refs"

// A directory with no repository: a bare number that fell back to the working tree would fail here.
const CTX = { cwd: "/" }
const TARGET = parseRepo("octo/hello")

describe("resolveRelatedIssue", () => {
  test.each(["12", "#12", " 12 "])("a bare number (%p) means the target repository", async (ref) => {
    const issue = await resolveRelatedIssue(ref, TARGET, CTX)
    expect(issueLabel(issue)).toBe("octo/hello#12")
  })

  test("owner/repo#N and URLs name their own repository, even another one", async () => {
    expect(issueLabel(await resolveRelatedIssue("other/thing#3", TARGET, CTX))).toBe("other/thing#3")
    expect(issueLabel(await resolveRelatedIssue("https://github.com/other/thing/issues/4", TARGET, CTX))).toBe(
      "other/thing#4",
    )
  })

  test("a pull request URL, or something that is no reference, is invalid_argument", async () => {
    for (const ref of ["https://github.com/octo/hello/pull/5", "soon", "0"]) {
      expect((await failure(resolveRelatedIssue(ref, TARGET, CTX))).code).toBe("invalid_argument")
    }
  })
})

describe("ghIssueRef", () => {
  test("is the number within the target repository, whatever the case of its name", async () => {
    expect(ghIssueRef(await resolveRelatedIssue("Octo/Hello#12", TARGET, CTX), TARGET)).toBe("12")
    expect(ghIssueRef(await resolveRelatedIssue("12", TARGET, CTX), TARGET)).toBe("12")
  })

  test("is the URL for an issue of another repository", async () => {
    expect(ghIssueRef(await resolveRelatedIssue("other/thing#3", TARGET, CTX), TARGET)).toBe(
      "https://github.com/other/thing/issues/3",
    )
  })
})
