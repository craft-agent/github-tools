import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { repositoryViewRule, writeLog } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { repoArchive } from "./repo-archive"

const { use, run } = writeHarness(repoArchive)
const patched = { match: "-X PATCH" }

test("PATCH archives the repository", async () => {
  const installed = use([repositoryViewRule(), patched])
  expect(await run({})).toEqual({ repo: "octo/hello", archived: true })
  expect(writeLog(installed)).toEqual([
    { args: ["api", "-X", "PATCH", "repos/octo/hello", "--input", "-"], body: { archived: true } },
  ])
})

test.each([true, false])("confirmation accepted=%p", async (accept) => {
  const installed = use([repositoryViewRule(), patched])
  const requests: ConfirmRequest[] = []
  const result = invoke(
    repoArchive,
    { repo: "octo/hello" },
    {
      cwd: process.cwd(),
      confirm: async (request) => {
        requests.push(request)
        return accept
      },
    },
  )
  if (accept) expect((await result).archived).toBe(true)
  else expect((await failure(result)).code).toBe("declined")
  expect(requests).toEqual([
    {
      tool: "github_repo_archive",
      message:
        "Archive octo/hello? It becomes read-only: no pushes, issues, pull requests or comments until it is unarchived.",
    },
  ])
  expect(writeLog(installed).length).toBe(accept ? 1 : 0)
})

test("an archived repository is refused without writing", async () => {
  const installed = use([repositoryViewRule({ isArchived: true }), patched])
  const error = await failure(run({}))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("octo/hello is archived already.")
  expect(writeLog(installed)).toEqual([])
})

test.each(["WRITE", "MAINTAIN", null])("permission %p is not admin", async (permission) => {
  const installed = use([repositoryViewRule({ viewerPermission: permission }), patched])
  const error = await failure(run({}))
  expect(error.code).toBe("forbidden")
  expect(error.message).toContain("No admin permission on octo/hello")
  expect(writeLog(installed)).toEqual([])
})

test("another repository is named by repo", async () => {
  const installed = use([repositoryViewRule({ nameWithOwner: "other/thing" }), patched])
  expect(await run({ repo: "other/thing" })).toEqual({ repo: "other/thing", archived: true })
  expect(writeLog(installed)[0]!.args).toContain("repos/other/thing")
})
