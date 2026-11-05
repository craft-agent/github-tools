import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { gqlErrors } from "../../testing/gql"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  FILES,
  HEAD,
  apiCalls,
  failure,
  filesRule,
  headRule,
  rawFile,
  variable,
} from "../../testing/pull-request-fixtures"
import { invoke } from "../tool"
import { PATCH_BUDGET } from "./diff"
import { prRead } from "./read"

let repo: TempRepo
let fake: FakeGh | undefined
beforeEach(() => {
  repo = tempRepo("https://github.com/octo/hello.git")
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
const read = (args: Record<string, unknown> = {}) =>
  invoke(prRead, { method: "diff", pr: "7", ...args }, { cwd: repo.dir })
const paths = (result: Awaited<ReturnType<typeof read>>) => result.files?.map((file) => file.path)

test("maps the files of a pull request", async () => {
  const installed = useFake([
    headRule(3),
    filesRule(1, [
      rawFile("src/a.ts", { additions: 4, deletions: 2 }),
      rawFile("src/new.ts", { status: "renamed", previous_filename: "src/old.ts", patch: undefined }),
      rawFile("logo.png", { status: "added", patch: undefined }),
    ]),
  ])
  expect(await read()).toEqual({
    repo: "octo/hello",
    pr: { number: 7, head_sha: "abc123" },
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        previous_path: null,
        additions: 4,
        deletions: 2,
        patch: "@@ -1 +1 @@\n+src/a.ts",
      },
      { path: "src/new.ts", status: "renamed", previous_path: "src/old.ts", additions: 1, deletions: 0, patch: null },
      { path: "logo.png", status: "added", previous_path: null, additions: 1, deletions: 0, patch: null },
    ],
    total_files: 3,
    files_truncated: false,
    patches_truncated: false,
  })
  expect(apiCalls(installed).map((args) => args[1])).toEqual([
    "graphql",
    "repos/octo/hello/pulls/7/files?per_page=100&page=1",
  ])
  expect(variable(apiCalls(installed)[0]!, "n")).toBe("7")
})

test("reads the next page while a page is full", async () => {
  const first = Array.from({ length: 100 }, (_, i) => rawFile(`f${i}.ts`))
  const installed = useFake([headRule(101), filesRule(1, first), filesRule(2, [rawFile("last.ts")])])
  const result = await read({ patch: false })
  expect(result.files).toHaveLength(101)
  expect(paths(result)?.at(-1)).toBe("last.ts")
  expect(result.files_truncated).toBe(false)
  expect(apiCalls(installed).map((args) => args[1])).toEqual([
    "graphql",
    "repos/octo/hello/pulls/7/files?per_page=100&page=1",
    "repos/octo/hello/pulls/7/files?per_page=100&page=2",
  ])
})

test("stops at 30 pages and says files were left out", async () => {
  const full = Array.from({ length: 100 }, (_, i) => rawFile(`f${i}.ts`, { patch: undefined }))
  const installed = useFake([headRule(3200), { match: FILES, stdout: JSON.stringify(full) }])
  const result = await read()
  expect(result.files).toHaveLength(3000)
  expect(result.total_files).toBe(3200)
  expect(result.files_truncated).toBe(true)
  expect(apiCalls(installed)).toHaveLength(31)
})

test.each([
  ["a directory", ["src/core"], ["src/core/a.ts", "src/core/deep/b.ts"]],
  ["a directory with a trailing slash", ["src/core/"], ["src/core/a.ts", "src/core/deep/b.ts"]],
  ["an exact file", ["README.md"], ["README.md"]],
  ["several paths", ["README.md", "src/core/a.ts"], ["src/core/a.ts", "README.md"]],
  ["a prefix that is not a directory", ["src/co"], []],
  ["a file as a directory", ["README.md/x"], []],
  ["an empty list", [], ["src/core/a.ts", "src/core/deep/b.ts", "src/corehub/c.ts", "README.md"]],
])("paths: %s", async (_name, filter, expected) => {
  useFake([
    headRule(4),
    filesRule(1, [
      rawFile("src/core/a.ts"),
      rawFile("src/core/deep/b.ts"),
      rawFile("src/corehub/c.ts"),
      rawFile("README.md"),
    ]),
  ])
  const result = await read({ paths: filter })
  expect(paths(result)).toEqual(expected)
  expect(result.total_files).toBe(4)
  expect(result.files_truncated).toBe(false)
})

test("patch false leaves every patch out", async () => {
  useFake([headRule(1), filesRule(1, [rawFile("a.ts")])])
  const result = await read({ patch: false })
  expect(result.files?.map((file) => file.patch)).toEqual([null])
  expect(result.patches_truncated).toBe(false)
})

test("patches past the budget are left out from the first one that does not fit", async () => {
  const big = (size: number) => "x".repeat(size)
  const installed = useFake([
    headRule(5),
    filesRule(1, [
      rawFile("a.ts", { patch: big(PATCH_BUDGET - 10) }),
      rawFile("b.ts", { patch: big(11) }),
      rawFile("c.ts", { patch: big(5) }),
      rawFile("d.png", { patch: undefined }),
      rawFile("e.ts", { patch: big(10) }),
    ]),
  ])
  const result = await read()
  expect(result.files?.map((file) => [file.path, file.patch?.length ?? null])).toEqual([
    ["a.ts", PATCH_BUDGET - 10],
    ["b.ts", null],
    ["c.ts", null],
    ["d.png", null],
    ["e.ts", null],
  ])
  expect(result.patches_truncated).toBe(true)
  expect(result.files_truncated).toBe(false)
  expect(apiCalls(installed)).toHaveLength(2)
})

test("a patch that exactly fills the budget is kept", async () => {
  useFake([
    headRule(2),
    filesRule(1, [rawFile("a.ts", { patch: "x".repeat(PATCH_BUDGET) }), rawFile("b.png", { patch: undefined })]),
  ])
  const result = await read()
  expect(result.files?.[0]?.patch).toHaveLength(PATCH_BUDGET)
  expect(result.patches_truncated).toBe(false)
})

test("the budget counts only the files that paths keeps", async () => {
  useFake([
    headRule(2),
    filesRule(1, [
      rawFile("skip.ts", { patch: "x".repeat(PATCH_BUDGET) }),
      rawFile("keep.ts", { patch: "y".repeat(10) }),
    ]),
  ])
  const result = await read({ paths: ["keep.ts"] })
  expect(result.files?.map((file) => file.patch?.length)).toEqual([10])
  expect(result.patches_truncated).toBe(false)
})

test.each([false, true])("not_found wording, GraphQL error: %p", async (graphqlError) => {
  const installed = useFake([
    graphqlError
      ? { match: HEAD, stdout: gqlErrors([{ type: "NOT_FOUND", message: "Could not resolve" }]) }
      : { match: HEAD, stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) },
  ])
  const error = await failure(read({ pr: "99" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe(
    "Pull request octo/hello#99 was not found: it does not exist, is an issue, or the viewer cannot see it.",
  )
  expect(apiCalls(installed)).toHaveLength(1)
})

test.each([undefined, "", "   "])("missing pr %p", async (pr) => {
  const error = await failure(read({ pr }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('method "diff" needs `pr`: 12, #12, owner/repo#12 or its URL.')
})

test.each([
  ["comments", 3, "view"],
  ["limit", 5, "list"],
  ["wait", 5, "checks"],
])("diff refuses %s", async (name, value, owner) => {
  const error = await failure(read({ [name]: value }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(`"${name}" is an argument of method "${owner}", not "diff"; leave it out.`)
})
