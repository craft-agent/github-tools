import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { graphqlCalls, graphqlRule, page, repositoryReply } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { labelRead } from "./label-read"

const { use, run } = writeHarness(labelRead)

const LABELS = "labels\\(first:100"

const raw = (name: string, description: string | null = null) => ({ name, color: "d73a4a", description })
const expected = (name: string, description = "") => ({ name, color: "d73a4a", description })

const labelPages = (labels: unknown[], next: string | null = null, times?: number) =>
  graphqlRule(LABELS, { repository: { labels: page(labels, next) } }, times)

describe("list", () => {
  test("labels by name with empty text for a missing description", async () => {
    const installed = use([labelPages([raw("bug", "Something isn't working"), raw("docs")])])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      labels: [expected("bug", "Something isn't working"), expected("docs")],
      truncated: false,
    })
    const [call, ...others] = graphqlCalls(installed)
    expect(others).toEqual([])
    expect(call!.query).toContain("orderBy:{field:NAME,direction:ASC}")
    expect(call!.vars).toEqual({ owner: "octo", name: "hello", after: "null" })
  })

  test("repo names another repository", async () => {
    const installed = use([labelPages([])])
    expect((await run({ method: "list", repo: "other/thing" })).repo).toBe("other/thing")
    expect(graphqlCalls(installed)[0]!.vars.owner).toBe("other")
  })

  test("limit cuts the labels and truncated says more matched", async () => {
    use([labelPages([raw("a"), raw("b"), raw("c")], "c1")])
    const result = await run({ method: "list", limit: 2 })
    expect(result.labels.map((label) => label.name)).toEqual(["a", "b"])
    expect(result.truncated).toBe(true)
  })

  test("pages are followed from the cursor", async () => {
    const installed = use([labelPages([raw("a")], "c1", 1), labelPages([raw("b")])])
    const result = await run({ method: "list" })
    expect(result.labels.map((label) => label.name)).toEqual(["a", "b"])
    expect(result.truncated).toBe(false)
    expect(graphqlCalls(installed).map((call) => call.vars.after)).toEqual(["null", "c1"])
  })

  test("search matches a part of the name without regard to case, across pages", async () => {
    const installed = use([
      labelPages([raw("area/bug-report"), raw("docs", "A bug in the docs")], "c1", 1),
      labelPages([raw("Debugging"), raw("feature")]),
    ])
    const result = await run({ method: "list", search: " BUG " })
    expect(result.labels.map((label) => label.name)).toEqual(["area/bug-report", "Debugging"])
    expect(result.truncated).toBe(false)
    expect(graphqlCalls(installed)).toHaveLength(2)
    expect(graphqlCalls(installed)[0]!.query).not.toContain("query:")
  })

  test("with search, truncated says more than limit matched", async () => {
    use([labelPages([raw("bug-a"), raw("other"), raw("bug-b"), raw("bug-c")])])
    const result = await run({ method: "list", search: "bug", limit: 2 })
    expect(result.labels.map((label) => label.name)).toEqual(["bug-a", "bug-b"])
    expect(result.truncated).toBe(true)
  })

  test("a blank search lists every label", async () => {
    use([labelPages([raw("a"), raw("b")])])
    expect((await run({ method: "list", search: "  " })).labels).toHaveLength(2)
  })

  test("a missing repository is not_found", async () => {
    use([{ match: LABELS, stdout: repositoryReply(null) }])
    const error = await failure(run({ method: "list" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Repository octo/hello was not found, or the viewer cannot see it.")
  })

  test.each([0, 1001, 1.5])("invalid limit %p", async (limit) => {
    use([])
    expect((await failure(run({ method: "list", limit }))).code).toBe("invalid_argument")
  })
})
