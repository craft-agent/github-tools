import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { REPOSITORY_VIEW, repositoryReply, repositoryViewRule, writeLog } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { repoUnarchive } from "./repo-unarchive"

const { use, run } = writeHarness(repoUnarchive)
const patched = { match: "-X PATCH" }

test("PATCH unarchives an archived repository", async () => {
  const installed = use([repositoryViewRule({ isArchived: true }), patched])
  expect(await run({})).toEqual({ repo: "octo/hello", archived: false, changed: true })
  expect(writeLog(installed)).toEqual([
    { args: ["api", "-X", "PATCH", "repos/octo/hello", "--input", "-"], body: { archived: false } },
  ])
})

test("a repository that is not archived sends nothing", async () => {
  const installed = use([repositoryViewRule(), patched])
  expect(await run({})).toEqual({ repo: "octo/hello", archived: false, changed: false })
  expect(writeLog(installed)).toEqual([])
})

test("admin permission is required", async () => {
  const installed = use([repositoryViewRule({ isArchived: true, viewerPermission: "WRITE" }), patched])
  expect((await failure(run({}))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("a missing repository is not_found", async () => {
  use([{ match: REPOSITORY_VIEW, stdout: repositoryReply(null) }, patched])
  expect((await failure(run({ repo: "octo/gone" }))).code).toBe("not_found")
})
