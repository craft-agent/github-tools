import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { repositoryViewRule, restFailure, writeLog } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { repoVisibility } from "./repo-visibility"

const { use, run } = writeHarness(repoVisibility)
const patched = { match: "-X PATCH" }

test("PATCH sends the visibility and reports the previous one", async () => {
  const installed = use([repositoryViewRule({ visibility: "PRIVATE" }), patched])
  expect(await run({ visibility: "public" })).toEqual({ repo: "octo/hello", visibility: "public", previous: "private" })
  expect(writeLog(installed)).toEqual([
    { args: ["api", "-X", "PATCH", "repos/octo/hello", "--input", "-"], body: { visibility: "public" } },
  ])
})

test("an organization's repository may become internal", async () => {
  const installed = use([repositoryViewRule({ visibility: "PRIVATE" }), patched])
  expect((await run({ visibility: "internal" })).visibility).toBe("internal")
  expect(writeLog(installed)[0]!.body).toEqual({ visibility: "internal" })
})

test.each([
  ["PRIVATE", "public", "Make octo/hello public? Its code, history, issues and wiki become readable by anyone."],
  ["INTERNAL", "public", "Make octo/hello public? Its code, history, issues and wiki become readable by anyone."],
  ["PUBLIC", "private", "Make octo/hello private? Its stars and watchers are lost, and its forks stay public."],
  ["PUBLIC", "internal", "Make octo/hello internal? Its stars and watchers are lost, and its forks stay public."],
  ["PRIVATE", "internal", "Make octo/hello internal? Every member of the enterprise can read it."],
  ["INTERNAL", "private", "Make octo/hello private? Only people given access can read it."],
])("%s to %s confirms what changes", async (from, to, message) => {
  use([repositoryViewRule({ visibility: from }), patched])
  const requests: ConfirmRequest[] = []
  await invoke(
    repoVisibility,
    { visibility: to },
    {
      cwd: process.cwd(),
      confirm: async (request) => {
        requests.push(request)
        return true
      },
    },
  )
  expect(requests).toEqual([{ tool: "github_repo_visibility", message }])
})

test.each([true, false])("confirmation accepted=%p", async (accept) => {
  const installed = use([repositoryViewRule({ visibility: "PRIVATE" }), patched])
  const result = invoke(
    repoVisibility,
    { repo: "octo/hello", visibility: "public" },
    { cwd: process.cwd(), confirm: async () => accept },
  )
  if (accept) expect((await result).visibility).toBe("public")
  else expect((await failure(result)).code).toBe("declined")
  expect(writeLog(installed).length).toBe(accept ? 1 : 0)
})

test("the visibility it has already is refused", async () => {
  const installed = use([repositoryViewRule(), patched])
  const error = await failure(run({ visibility: "public" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("octo/hello is public already.")
  expect(writeLog(installed)).toEqual([])
})

test("internal is refused for a user's repository", async () => {
  const installed = use([repositoryViewRule({ owner: { __typename: "User", login: "octo" } }), patched])
  const error = await failure(run({ visibility: "internal" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("internal is for an organization's repository; octo/hello belongs to a user.")
  expect(writeLog(installed)).toEqual([])
})

test("admin permission is required", async () => {
  const installed = use([repositoryViewRule({ viewerPermission: "MAINTAIN" }), patched])
  expect((await failure(run({ visibility: "private" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("an unknown visibility writes nothing", async () => {
  const installed = use([])
  expect((await failure(run({ visibility: "secret" }))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("the visibility is required", async () => {
  use([])
  expect((await failure(run({}))).code).toBe("invalid_argument")
})

test("GitHub's HTTP 422 is invalid_argument with GitHub's own words", async () => {
  use([
    repositoryViewRule({ visibility: "PRIVATE" }),
    restFailure(
      "-X PATCH",
      "Visibility Only organizations associated with an enterprise can set visibility to internal (HTTP 422)",
    ),
  ])
  const error = await failure(run({ visibility: "internal" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(
    "GitHub refused it: Visibility Only organizations associated with an enterprise can set visibility to internal.",
  )
})

test("another failed write keeps its code", async () => {
  use([repositoryViewRule({ visibility: "PRIVATE" }), restFailure("-X PATCH", "Forbidden (HTTP 403)")])
  expect((await failure(run({ visibility: "public" }))).code).toBe("forbidden")
})
