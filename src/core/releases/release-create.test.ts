import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  branchRule,
  gitRefTagRule,
  rawRelease,
  releaseByTagRule,
  releasesPageRule,
  restNotFound,
} from "../../testing/releases-fixtures"
import { restFailure, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { releaseCreate } from "./release-create"

const { use, run } = writeHarness(releaseCreate)

const created = (tag = "v1.0.0", extra: Record<string, unknown> = {}) => ({
  match: "-X POST",
  stdout: JSON.stringify(rawRelease(tag, { draft: true, published_at: null, ...extra })),
})

const notFoundRelease = (tag: string) => [releaseByTagRule(tag, null), releasesPageRule(1, [])]

test("POST creates a draft release sending draft: true and only given fields", async () => {
  const installed = use([repositoryRule(), ...notFoundRelease("v1.0.0"), created("v1.0.0")])
  expect(await run({ tag: "v1.0.0" })).toEqual({
    repo: "octo/hello",
    tag: "v1.0.0",
    url: "https://github.com/octo/hello/releases/tag/v1.0.0",
    draft: true,
    foreign: false,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "POST", "repos/octo/hello/releases", "--input", "-"],
      body: { draft: true, tag_name: "v1.0.0" },
    },
  ])
})

test("POST sends all optional fields when provided, and reports foreign repo", async () => {
  const installed = use([
    repositoryRule({ repo: "other/thing", viewer: "me" }),
    ...notFoundRelease("v2.0.0-rc.1"),
    restNotFound("git/ref/tags/v2.0.0-rc.1"),
    branchRule("develop", "develop-sha"),
    created("v2.0.0-rc.1", { html_url: "https://github.com/other/thing/releases/tag/v2.0.0-rc.1" }),
  ])
  expect(
    await run({
      repo: "other/thing",
      tag: "v2.0.0-rc.1",
      target: "develop",
      title: "Release 2.0.0-rc.1",
      notes: "Release notes here",
      generate_notes: true,
      prerelease: true,
    }),
  ).toEqual({
    repo: "other/thing",
    tag: "v2.0.0-rc.1",
    url: "https://github.com/other/thing/releases/tag/v2.0.0-rc.1",
    draft: true,
    foreign: true,
  })
  expect(writeLog(installed)).toEqual([
    {
      args: ["api", "-X", "POST", "repos/other/thing/releases", "--input", "-"],
      body: {
        draft: true,
        tag_name: "v2.0.0-rc.1",
        name: "Release 2.0.0-rc.1",
        body: "Release notes here",
        target_commitish: "develop",
        prerelease: true,
        generate_release_notes: true,
      },
    },
  ])
})

test("target given with 40-hex SHA passes without branch lookup", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"
  const installed = use([
    repositoryRule(),
    ...notFoundRelease("v1.0.0"),
    restNotFound("git/ref/tags/v1.0.0"),
    created("v1.0.0"),
  ])
  await run({ tag: "v1.0.0", target: sha })
  expect(writeLog(installed)[0]!.body).toEqual({
    draft: true,
    tag_name: "v1.0.0",
    target_commitish: sha,
  })
})

test("target given when tag exists already throws invalid_argument and writes nothing", async () => {
  const installed = use([
    repositoryRule(),
    ...notFoundRelease("v1.0.0"),
    gitRefTagRule("v1.0.0", { object: { type: "commit", sha: "abcdef1234567890abcdef1234567890abcdef12" } }),
    created("v1.0.0"),
  ])
  const error = await failure(run({ tag: "v1.0.0", target: "main" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("Tag v1.0.0 exists already at abcdef1; target is only for a new tag.")
  expect(writeLog(installed)).toEqual([])
})

test("target given with non-existent branch throws invalid_argument and writes nothing", async () => {
  const installed = use([
    repositoryRule(),
    ...notFoundRelease("v1.0.0"),
    restNotFound("git/ref/tags/v1.0.0"),
    restNotFound("branches/missing-branch"),
    created("v1.0.0"),
  ])
  const error = await failure(run({ tag: "v1.0.0", target: "missing-branch" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe('octo/hello has no branch "missing-branch"; give a branch or a full commit SHA.')
  expect(writeLog(installed)).toEqual([])
})

test("existing draft release is refused pointing to github_release_edit", async () => {
  const installed = use([
    repositoryRule(),
    releaseByTagRule("v1.0.0", null),
    releasesPageRule(1, [rawRelease("v1.0.0", { draft: true })]),
    created("v1.0.0"),
  ])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("octo/hello has a draft release v1.0.0 already; change it with github_release_edit.")
  expect(writeLog(installed)).toEqual([])
})

test("existing published release is refused pointing to github_release_edit", async () => {
  const installed = use([repositoryRule(), releaseByTagRule("v1.0.0", rawRelease("v1.0.0")), created("v1.0.0")])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("octo/hello has a published release v1.0.0 already; change it with github_release_edit.")
  expect(writeLog(installed)).toEqual([])
})

test.each([
  { tag: "" },
  { tag: " " },
  { tag: "v1..0" },
  { tag: "v1//0" },
  { tag: "v1.lock" },
  { tag: "v1." },
  { tag: "v1/" },
  { tag: ".v1" },
])("invalid tag %p sends no write", async (args) => {
  const installed = use([])
  expect((await failure(run(args as { tag: string }))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("GitHub HTTP 422 is invalid_argument with GitHub's words", async () => {
  use([
    repositoryRule(),
    ...notFoundRelease("v1.0.0"),
    restFailure("-X POST", "Validation Failed (HTTP 422)", { errors: ["tag_name is invalid"] }),
  ])
  const error = await failure(run({ tag: "v1.0.0" }))
  expect(error.code).toBe("invalid_argument")
  expect(error.message).toBe("GitHub refused it: Validation Failed: tag_name is invalid.")
})

test("server error keeps its code", async () => {
  use([repositoryRule(), ...notFoundRelease("v1.0.0"), restFailure("-X POST", "Server Error (HTTP 500)")])
  expect((await failure(run({ tag: "v1.0.0" }))).code).toBe("github_error")
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ tag: "v1.0.0" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})
