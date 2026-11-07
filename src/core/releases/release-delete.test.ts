import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  RELEASE_COMMIT,
  gitRefTagRule,
  rawRelease,
  releaseByTagRule,
  releasesPageRule,
  restNotFound,
} from "../../testing/releases-fixtures"
import { restFailure, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { releaseDelete } from "./release-delete"

const { use, run } = writeHarness(releaseDelete)

const deleted = { match: "-X DELETE" }

test("DELETE deletes a published release by id, reporting tag_kept true and foreign", async () => {
  const current = rawRelease("v1.0.0")
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    releaseByTagRule("v1.0.0", current),
    gitRefTagRule("v1.0.0", { object: { type: "commit", sha: RELEASE_COMMIT } }),
    deleted,
  ])
  expect(await run({ repo: "other/thing", tag: "v1.0.0" })).toEqual({
    repo: "other/thing",
    deleted: "v1.0.0",
    tag_kept: true,
    foreign: true,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "DELETE", "repos/other/thing/releases/101"],
      body: null,
    },
  ])
})

test("draft found by scan is deleted by its id with tag_kept false when tag does not exist", async () => {
  const current = rawRelease("v2.0.0-draft", { id: 202, draft: true })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v2.0.0-draft", null),
    releasesPageRule(1, [current]),
    restNotFound("git/ref/tags/v2.0.0-draft"),
    deleted,
  ])
  expect(await run({ tag: "v2.0.0-draft" })).toEqual({
    repo: "octo/hello",
    deleted: "v2.0.0-draft",
    tag_kept: false,
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "DELETE", "repos/octo/hello/releases/202"],
      body: null,
    },
  ])
})

test.each([
  [true, false, "published"],
  [false, true, "draft"],
])("confirmation accepted=%p for %s release", async (accept, isDraft, kind) => {
  const current = rawRelease("v1.0.0", { draft: isDraft })
  const installed = use([
    repositoryRule(),
    ...(isDraft
      ? [releaseByTagRule("v1.0.0", null), releasesPageRule(1, [current])]
      : [releaseByTagRule("v1.0.0", current)]),
    restNotFound("git/ref/tags/v1.0.0"),
    deleted,
  ])
  const requests: ConfirmRequest[] = []
  const result = invoke(
    releaseDelete,
    { repo: "octo/hello", tag: "v1.0.0" },
    {
      cwd: process.cwd(),
      confirm: async (request) => {
        requests.push(request)
        return accept
      },
    },
  )
  if (accept) expect((await result).deleted).toBe("v1.0.0")
  else expect((await failure(result)).code).toBe("declined")
  expect(requests).toEqual([
    {
      tool: "github_release_delete",
      message: `Delete the ${kind} release v1.0.0 from octo/hello? Its tag stays; the release and its assets cannot be brought back.`,
    },
  ])
  expect(writeLog(installed).length).toBe(accept ? 1 : 0)
})

test("unknown release throws not_found without writing", async () => {
  const installed = use([repositoryRule(), releaseByTagRule("v9.9.9", null), releasesPageRule(1, []), deleted])
  const error = await failure(run({ tag: "v9.9.9" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe("Release v9.9.9 was not found in octo/hello, or the viewer cannot see it.")
  expect(writeLog(installed)).toEqual([])
})

test("GitHub HTTP 422 is invalid_argument with GitHub's words", async () => {
  const current = rawRelease("v1.0.0")
  use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", current),
    restNotFound("git/ref/tags/v1.0.0"),
    restFailure("-X DELETE", "Validation Failed (HTTP 422)", { errors: ["cannot delete release"] }),
  ])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("GitHub refused it: Validation Failed: cannot delete release.")
})

test("server error keeps its code", async () => {
  const current = rawRelease("v1.0.0")
  use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", current),
    restNotFound("git/ref/tags/v1.0.0"),
    restFailure("-X DELETE", "Server Error (HTTP 500)"),
  ])
  expect((await failure(run({ tag: "v1.0.0" }))).code).toBe("github_error")
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ tag: "v1.0.0" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})
