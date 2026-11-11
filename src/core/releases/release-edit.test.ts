import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  RELEASE_COMMIT,
  branchRule,
  gitRefTagRule,
  rawRelease,
  releaseByTagRule,
  releasesLatestRule,
  releasesPageRule,
  restNotFound,
} from "../../testing/releases-fixtures"
import { restFailure, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { releaseEdit } from "./release-edit"

const { use, run } = writeHarness(releaseEdit)

const edited = (tag = "v1.0.0", extra: Record<string, unknown> = {}) => ({
  match: "-X PATCH",
  stdout: JSON.stringify(rawRelease(tag, extra)),
})

test("PATCH sends changed fields and reports changed array and foreign repo", async () => {
  const current = rawRelease("v1.0.0", {
    name: "Old Title",
    body: "Old Notes",
  })
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    releaseByTagRule("v1.0.0", current),
    releasesLatestRule({ id: 999 }),
    edited("v1.0.0"),
  ])
  expect(
    await run({
      repo: "other/thing",
      tag: "v1.0.0",
      title: "New Title",
      notes: "New Notes",
      prerelease: false,
      latest: true,
    }),
  ).toEqual({
    repo: "other/thing",
    tag: "v1.0.0",
    changed: ["title", "notes", "latest"],
    foreign: true,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/other/thing/releases/101", "--input", "-"],
      body: { tag_name: "v1.0.0", name: "New Title", body: "New Notes", make_latest: "true" },
    },
  ])
})

test("latest: false sends make_latest 'false' when the release was latest", async () => {
  const current = rawRelease("v1.0.0")
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", current),
    releasesLatestRule({ id: 101 }),
    edited("v1.0.0"),
  ])
  const result = await run({ tag: "v1.0.0", latest: false })
  expect(result.changed).toEqual(["latest"])
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/releases/101", "--input", "-"],
      body: { tag_name: "v1.0.0", make_latest: "false" },
    },
  ])
})

test("nothing changed sends no PATCH and returns changed []", async () => {
  const current = rawRelease("v1.0.0", {
    name: "Same",
    body: "Same notes",
  })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", current),
    releasesLatestRule({ id: 999 }),
    edited("v1.0.0"),
  ])
  expect(
    await run({
      tag: "v1.0.0",
      title: "Same",
      notes: "Same notes",
      prerelease: false,
      latest: false,
    }),
  ).toEqual({
    repo: "octo/hello",
    tag: "v1.0.0",
    changed: [],
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([])
})

test("target on a draft without tag accepted with SHA or branch", async () => {
  const current = rawRelease("v2.0.0", { id: 202, draft: true, target_commitish: "main" })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v2.0.0", null),
    releasesPageRule(1, [current]),
    restNotFound("git/ref/tags/v2.0.0"),
    branchRule("feature", "feat-sha"),
    edited("v2.0.0"),
  ])
  const result = await run({ tag: "v2.0.0", target: "feature" })
  expect(result.changed).toEqual(["target"])
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/releases/202", "--input", "-"],
      body: { tag_name: "v2.0.0", target_commitish: "feature" },
    },
  ])
})

test("tag_name is sent when only notes change on a draft", async () => {
  const current = rawRelease("v1.5.0-draft", { id: 150, draft: true, body: "Old notes" })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.5.0-draft", null),
    releasesPageRule(1, [current]),
    edited("v1.5.0-draft"),
  ])
  const result = await run({ tag: "v1.5.0-draft", notes: "Updated notes" })
  expect(result.changed).toEqual(["notes"])
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/releases/150", "--input", "-"],
      body: { tag_name: "v1.5.0-draft", body: "Updated notes" },
    },
  ])
})

test("refuses no change arguments without writing", async () => {
  const installed = use([])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("Pass at least one of title, notes, prerelease, latest or target to change the release.")
  expect(writeLog(installed)).toEqual([])
})

test("refuses prerelease: true with latest: true without writing", async () => {
  const installed = use([])
  const error = await failure(run({ tag: "v1.0.0", prerelease: true, latest: true }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("A prerelease cannot be the latest release.")
  expect(writeLog(installed)).toEqual([])
})

test("refuses latest: true on an existing prerelease without writing", async () => {
  const current = rawRelease("v1.0.0", { prerelease: true })
  const installed = use([repositoryRule(), releaseByTagRule("v1.0.0", current)])
  const error = await failure(run({ tag: "v1.0.0", latest: true }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("A prerelease cannot be the latest release.")
  expect(writeLog(installed)).toEqual([])
})

test("refuses latest on a draft without writing", async () => {
  const current = rawRelease("v1.0.0", { draft: true })
  const installed = use([repositoryRule(), releaseByTagRule("v1.0.0", null), releasesPageRule(1, [current])])
  const error = await failure(run({ tag: "v1.0.0", latest: true }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(
    "Release v1.0.0 of octo/hello is a draft; mark it latest when publishing it with github_release_publish.",
  )
  expect(writeLog(installed)).toEqual([])
})

test("refuses target on a published release without writing", async () => {
  const current = rawRelease("v1.0.0")
  const installed = use([repositoryRule(), releaseByTagRule("v1.0.0", current)])
  const error = await failure(run({ tag: "v1.0.0", target: "main" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(
    "Release v1.0.0 of octo/hello is a published release; its tag already names a commit; target is only for a draft whose tag does not exist yet.",
  )
  expect(writeLog(installed)).toEqual([])
})

test("refuses target on a draft when tagCommit exists already without writing", async () => {
  const current = rawRelease("v1.0.0", { draft: true })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", null),
    releasesPageRule(1, [current]),
    gitRefTagRule("v1.0.0", { object: { type: "commit", sha: RELEASE_COMMIT } }),
  ])
  const error = await failure(run({ tag: "v1.0.0", target: "main" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(
    "Release v1.0.0 of octo/hello is a draft, but its tag already names a commit; target is only for a draft whose tag does not exist yet.",
  )
  expect(writeLog(installed)).toEqual([])
})

test("refuses missing branch target without writing", async () => {
  const current = rawRelease("v1.0.0", { draft: true })
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", null),
    releasesPageRule(1, [current]),
    restNotFound("git/ref/tags/v1.0.0"),
    restNotFound("branches/nonexistent"),
  ])
  const error = await failure(run({ tag: "v1.0.0", target: "nonexistent" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('octo/hello has no branch "nonexistent"; give a branch or a full commit SHA.')
  expect(writeLog(installed)).toEqual([])
})

test("unknown release throws not_found without writing", async () => {
  const installed = use([repositoryRule(), releaseByTagRule("v9.9.9", null), releasesPageRule(1, [])])
  const error = await failure(run({ tag: "v9.9.9", title: "New" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe("Release v9.9.9 was not found in octo/hello, or the viewer cannot see it.")
  expect(writeLog(installed)).toEqual([])
})

test("GitHub HTTP 422 is invalid_argument with GitHub's words", async () => {
  const current = rawRelease("v1.0.0")
  use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", current),
    restFailure("-X PATCH", "Validation Failed (HTTP 422)", { errors: ["body is too long"] }),
  ])
  const error = await failure(run({ tag: "v1.0.0", notes: "Too long" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("GitHub refused it: Validation Failed: body is too long.")
})

test("server error keeps its code", async () => {
  const current = rawRelease("v1.0.0")
  use([repositoryRule(), releaseByTagRule("v1.0.0", current), restFailure("-X PATCH", "Server Error (HTTP 500)")])
  expect((await failure(run({ tag: "v1.0.0", notes: "Fail" }))).code).toBe("upstream_error")
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ tag: "v1.0.0", title: "Test" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})
