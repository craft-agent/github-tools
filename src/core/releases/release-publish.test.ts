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
import { invoke, type ConfirmRequest } from "../tool"
import { releasePublish } from "./release-publish"

const { use, run } = writeHarness(releasePublish)

const BRANCH_SHA = "1111111111222222222233333333334444444444"
const SHA_TARGET = "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd"
const OTHER_SHA = "5555555555666666666677777777778888888888"

const publishedRule = (tag = "v1.0.0", extra: Record<string, unknown> = {}) => ({
  match: "-X PATCH",
  stdout: JSON.stringify(rawRelease(tag, { draft: false, ...extra })),
})

const draftRules = (tag: string, extra: Record<string, unknown> = {}) => {
  const draft = rawRelease(tag, { id: 101, draft: true, published_at: null, ...extra })
  return [releaseByTagRule(tag, null), releasesPageRule(1, [draft])]
}

test("tag new with branch target: pins target_commitish to branch head SHA, reports latest true", async () => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "main" }),
    restNotFound("git/ref/tags/v1.0.0"),
    branchRule("main", BRANCH_SHA),
    publishedRule("v1.0.0"),
    releasesLatestRule({ id: 101 }),
  ])

  const result = await run({ tag: "v1.0.0" })
  expect(result).toEqual({
    repo: "octo/hello",
    tag: "v1.0.0",
    commit: BRANCH_SHA,
    url: "https://github.com/octo/hello/releases/tag/v1.0.0",
    latest: true,
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/releases/101", "--input", "-"],
      body: { tag_name: "v1.0.0", draft: false, target_commitish: BRANCH_SHA },
    },
  ])
})

test("tag new with SHA target: pins target_commitish to SHA, latest false sends make_latest false, foreign repo", async () => {
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    ...draftRules("v1.0.0", { target_commitish: SHA_TARGET }),
    restNotFound("git/ref/tags/v1.0.0"),
    publishedRule("v1.0.0"),
    releasesLatestRule({ id: 999 }),
  ])

  const result = await run({ repo: "other/thing", tag: "v1.0.0", latest: false })
  expect(result).toEqual({
    repo: "other/thing",
    tag: "v1.0.0",
    commit: SHA_TARGET,
    url: "https://github.com/octo/hello/releases/tag/v1.0.0",
    latest: false,
    foreign: true,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/other/thing/releases/101", "--input", "-"],
      body: { tag_name: "v1.0.0", draft: false, target_commitish: SHA_TARGET, make_latest: "false" },
    },
  ])
})

test("tag exists: sends no target_commitish, latest true sends make_latest true", async () => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0"),
    gitRefTagRule("v1.0.0", { object: { type: "commit", sha: RELEASE_COMMIT } }),
    publishedRule("v1.0.0"),
    releasesLatestRule({ id: 101 }),
  ])

  const result = await run({ tag: "v1.0.0", latest: true })
  expect(result).toEqual({
    repo: "octo/hello",
    tag: "v1.0.0",
    commit: RELEASE_COMMIT,
    url: "https://github.com/octo/hello/releases/tag/v1.0.0",
    latest: true,
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "PATCH", "repos/octo/hello/releases/101", "--input", "-"],
      body: { tag_name: "v1.0.0", draft: false, make_latest: "true" },
    },
  ])
})

test("matching head_sha (case-insensitive) succeeds", async () => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "main" }),
    restNotFound("git/ref/tags/v1.0.0"),
    branchRule("main", BRANCH_SHA.toLowerCase()),
    publishedRule("v1.0.0"),
    releasesLatestRule({ id: 101 }),
  ])

  const result = await run({ tag: "v1.0.0", head_sha: BRANCH_SHA.toUpperCase() })
  expect(result.commit).toBe(BRANCH_SHA.toLowerCase())
  expect(writeLog(installed).length).toBe(1)
})

test("stale when head_sha differs from resolved commit", async () => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "main" }),
    restNotFound("git/ref/tags/v1.0.0"),
    branchRule("main", BRANCH_SHA),
    publishedRule("v1.0.0"),
  ])

  const error = await failure(run({ tag: "v1.0.0", head_sha: OTHER_SHA }))
  expect(error.code).toBe("stale")
  expect(error.message).toBe(
    `Release v1.0.0 of octo/hello would tag ${BRANCH_SHA.slice(0, 12)}, not ${OTHER_SHA.slice(0, 12)}: its target moved since it was read. Nothing was published.`,
  )
  expect(writeLog(installed)).toEqual([])
})

test("invalid head_sha throws invalid_argument before reading or writing", async () => {
  const installed = use([repositoryRule()])
  const error = await failure(run({ tag: "v1.0.0", head_sha: "short-sha" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("head_sha must be a full commit SHA of 40 hexadecimal characters.")
  expect(writeLog(installed)).toEqual([])
})

test.each([
  [true, false, "creates the tag at", "accepted"],
  [false, false, "creates the tag at", "declined"],
  [true, true, "Its tag already names", "accepted"],
  [false, true, "Its tag already names", "declined"],
])("confirmation %s (tagExists=%p) with text %p", async (accept, tagExists, expectedPhrase) => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "main" }),
    ...(tagExists
      ? [gitRefTagRule("v1.0.0", { object: { type: "commit", sha: RELEASE_COMMIT } })]
      : [restNotFound("git/ref/tags/v1.0.0"), branchRule("main", BRANCH_SHA)]),
    publishedRule("v1.0.0"),
    releasesLatestRule({ id: 101 }),
  ])

  const requests: ConfirmRequest[] = []
  const expectedCommit = tagExists ? RELEASE_COMMIT : BRANCH_SHA
  const expectedMsg = `Publish the release v1.0.0 of octo/hello? ${
    tagExists
      ? `Its tag already names ${expectedCommit.slice(0, 12)}`
      : `It creates the tag at ${expectedCommit.slice(0, 12)}`
  }, and everyone watching the repository is notified.`

  const result = invoke(
    releasePublish,
    { repo: "octo/hello", tag: "v1.0.0" },
    {
      cwd: process.cwd(),
      confirm: async (request) => {
        requests.push(request)
        return accept
      },
    },
  )

  if (accept) {
    expect((await result).tag).toBe("v1.0.0")
    expect(writeLog(installed).length).toBe(1)
  } else {
    const err = await failure(result)
    expect(err.code).toBe("declined")
    expect(err.message).toBe(`github_release_publish was declined: ${expectedMsg}`)
    expect(writeLog(installed)).toEqual([])
  }

  expect(requests).toEqual([{ tool: "github_release_publish", message: expectedMsg }])
  expect(requests[0]?.message).toContain(expectedPhrase)
})

test("unknown release throws not_found and writes nothing", async () => {
  const installed = use([repositoryRule(), releaseByTagRule("v9.9.9", null), releasesPageRule(1, [])])
  const error = await failure(run({ tag: "v9.9.9" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe("Release v9.9.9 was not found in octo/hello, or the viewer cannot see it.")
  expect(writeLog(installed)).toEqual([])
})

test("already published release throws invalid_argument and writes nothing", async () => {
  const installed = use([repositoryRule(), releaseByTagRule("v1.0.0", rawRelease("v1.0.0", { draft: false }))])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("Release v1.0.0 of octo/hello is published already.")
  expect(writeLog(installed)).toEqual([])
})

test("latest true on prerelease throws invalid_argument and writes nothing", async () => {
  const installed = use([repositoryRule(), ...draftRules("v1.0.0-rc.1", { prerelease: true })])
  const error = await failure(run({ tag: "v1.0.0-rc.1", latest: true }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("A prerelease cannot be the latest release.")
  expect(writeLog(installed)).toEqual([])
})

test("target branch gone throws invalid_argument and writes nothing", async () => {
  const installed = use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "deleted-branch" }),
    restNotFound("git/ref/tags/v1.0.0"),
    restNotFound("branches/deleted-branch"),
  ])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe(
    "Release v1.0.0 of octo/hello targets deleted-branch, which is no longer a branch; set target with github_release_edit.",
  )
  expect(writeLog(installed)).toEqual([])
})

test("read-only repository throws forbidden and writes nothing", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("GitHub HTTP 422 is invalid_argument with GitHub's words", async () => {
  use([
    repositoryRule(),
    ...draftRules("v1.0.0", { target_commitish: "main" }),
    restNotFound("git/ref/tags/v1.0.0"),
    branchRule("main", BRANCH_SHA),
    restFailure("-X PATCH", "Validation Failed (HTTP 422)", { errors: ["cannot publish release"] }),
  ])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("GitHub refused it: Validation Failed: cannot publish release.")
})
