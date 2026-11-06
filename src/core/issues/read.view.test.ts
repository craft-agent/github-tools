import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  DETAIL,
  EXPECTED_ISSUE,
  apiCalls,
  dependenciesRule,
  detailRule,
  failure,
  variable,
} from "../../testing/issue-fixtures"
import { invoke } from "../tool"
import { issueRead } from "./read"

const ORIGIN = "https://github.com/octo/hello.git"

let repo: TempRepo
let fake: FakeGh | undefined

beforeEach(() => {
  repo = tempRepo(ORIGIN)
})

afterEach(() => {
  fake?.restore()
  fake = undefined
  repo.cleanup()
})

function useFake(rules: GhRule[]): FakeGh {
  fake = installFakeGh(rules)
  return fake
}

const read = (args: Record<string, unknown>) => invoke(issueRead, args, { cwd: repo.dir })

describe("view", () => {
  test("returns the repository and the issue in full", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    const result = await read({ method: "view", issue: "12" })
    expect(result.repo).toBe("octo/hello")
    expect(result.issue).toEqual(EXPECTED_ISSUE)
    expect(variable(apiCalls(installed)[0]!, "comments")).toBe("5")
  })

  test("the query sent includes the issueFieldValues fragment", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    await read({ method: "view", issue: "12" })
    const call = apiCalls(installed).find((args) => args.join(" ").includes(DETAIL))
    expect(variable(call!, "query")).toContain("issueFieldValues(first:25)")
  })

  test("a schema error on issueFieldValues re-runs without the fragment and gives issue_fields: null", async () => {
    const installed = useFake([
      {
        match: DETAIL,
        stdout: gqlErrors([{ message: "Field 'issueFieldValues' doesn't exist on type 'Issue'" }]),
        times: 1,
      },
      detailRule(),
      dependenciesRule(),
    ])
    const result = await read({ method: "view", issue: "12" })
    expect(result.issue?.issue_fields).toBeNull()
    const calls = apiCalls(installed).filter((args) => args.join(" ").includes(DETAIL))
    expect(calls).toHaveLength(2)
    expect(variable(calls[0]!, "query")).toContain("issueFieldValues(first:25)")
    expect(variable(calls[1]!, "query")).not.toContain("issueFieldValues(first:25)")
  })

  test("an issue that does not exist is not_found", async () => {
    useFake([
      {
        match: DETAIL,
        stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }], {
          repository: { issue: null },
        }),
      },
    ])
    const error = await failure(read({ method: "view", issue: "99" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("octo/hello#99")
  })

  test("a pull request URL is invalid_argument and nothing is asked of GitHub", async () => {
    const installed = useFake([detailRule()])
    const error = await failure(read({ method: "view", issue: "https://github.com/octo/hello/pull/12" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("is a pull request, not an issue")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test("an issue URL and owner/repo#N name their own repository", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    const byUrl = await read({ method: "view", issue: "https://github.com/other/thing/issues/12#issuecomment-4" })
    expect(byUrl.repo).toBe("other/thing")
    expect(variable(apiCalls(installed)[0]!, "owner")).toBe("other")
    const byShort = await read({ method: "view", issue: "third/place#12" })
    expect(byShort.repo).toBe("third/place")
  })

  test("a bare number takes the repo argument over origin", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    const result = await read({ method: "view", issue: "#12", repo: "other/thing" })
    expect(result.repo).toBe("other/thing")
    expect(variable(apiCalls(installed)[0]!, "name")).toBe("thing")
  })

  test("a reference and a repo argument that disagree are invalid_argument", async () => {
    useFake([detailRule()])
    expect((await failure(read({ method: "view", issue: "a/b#1", repo: "c/d" }))).code).toBe("invalid_argument")
  })

  test("comments: 0 asks for none, 50 is the most", async () => {
    const installed = useFake([detailRule(), dependenciesRule()])
    await read({ method: "view", issue: "12", comments: 0 })
    await read({ method: "view", issue: "12", comments: 50 })
    const [none, most] = apiCalls(installed).filter((args) => args.join(" ").includes(DETAIL))
    expect(variable(none!, "withComments")).toBe("false")
    expect(variable(most!, "comments")).toBe("50")
  })

  test.each([51, -1, 2.5, "3"])("comments: %p is invalid_argument", async (comments) => {
    const installed = useFake([detailRule()])
    const error = await failure(read({ method: "view", issue: "12", comments }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("comments")
    expect(apiCalls(installed)).toHaveLength(0)
  })

  test.each([undefined, "", "   "])("view without an issue (%p) is invalid_argument", async (issue) => {
    useFake([])
    const error = await failure(read({ method: "view", issue }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("issue")
  })

  test.each(["state", "kind", "milestone", "label", "assignee", "parent", "query", "limit"])(
    "the list argument %s is refused, by name",
    async (name) => {
      const error = await failure(
        read({ method: "view", issue: "12", [name]: name === "limit" ? 5 : name === "state" ? "open" : "x" }),
      )
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain(`"${name}"`)
    },
  )

  test("an unknown method or argument is invalid_argument", async () => {
    useFake([])
    for (const args of [{ method: "show" }, { method: "view", issue: "12", sort: "asc" }, {}]) {
      expect((await failure(read(args))).code).toBe("invalid_argument")
    }
  })
})
