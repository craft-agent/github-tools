import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import {
  RELEASE_COMMIT,
  branchRule,
  expectedRelease,
  expectedReleaseRow,
  gitRefTagRule,
  gitTagRule,
  rawRelease,
  releaseByTagRule,
  releasesLatestRule,
  releasesPageRule,
  restNotFound,
  restPaths,
} from "../../testing/releases-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { releaseRead } from "./release-read"

const { use, run } = writeHarness(releaseRead)

const releases = (count: number) => Array.from({ length: count }, (_, i) => rawRelease(`v1.${i}.0`, { id: i + 1 }))

describe("list", () => {
  test("maps releases keeping order, drafts included, and marks the latest release", async () => {
    const installed = use([
      releasesPageRule(1, [
        rawRelease("v2.0.0", { id: 200 }),
        rawRelease("v1.5.0-draft", { id: 150, draft: true, published_at: null }),
        rawRelease("v1.0.0", { id: 100 }),
      ]),
      releasesLatestRule({ id: 200 }),
    ])
    expect(await run({ method: "list" })).toEqual({
      repo: "octo/hello",
      releases: [
        expectedReleaseRow("v2.0.0", { latest: true }),
        expectedReleaseRow("v1.5.0-draft", { draft: true, published_at: null, latest: false }),
        expectedReleaseRow("v1.0.0", { latest: false }),
      ],
      truncated: false,
    })
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases?per_page=100&page=1",
      "repos/octo/hello/releases/latest",
    ])
  })

  test("latest 404 means no release is marked latest", async () => {
    use([releasesPageRule(1, [rawRelease("v1.0.0", { id: 100 })]), restNotFound("releases/latest")])
    const result = await run({ method: "list" })
    expect(result.releases).toEqual([expectedReleaseRow("v1.0.0", { latest: false })])
  })

  test("truncated is true across pages when more existed than limit", async () => {
    const installed = use([releasesPageRule(1, releases(100)), releasesLatestRule({ id: 1 })])
    const result = await run({ method: "list", limit: 30 })
    expect(result.releases?.length).toBe(30)
    expect(result.truncated).toBe(true)
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases?per_page=100&page=1",
      "repos/octo/hello/releases/latest",
    ])
  })

  test("page 2 is checked when page 1 has 100 items and limit is 100", async () => {
    const installed = use([releasesPageRule(1, releases(100)), releasesPageRule(2, []), releasesLatestRule({ id: 1 })])
    const result = await run({ method: "list", limit: 100 })
    expect(result.releases?.length).toBe(100)
    expect(result.truncated).toBe(false)
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases?per_page=100&page=1",
      "repos/octo/hello/releases?per_page=100&page=2",
      "repos/octo/hello/releases/latest",
    ])
  })

  test("truncated is true when page 2 has an extra item beyond limit 100", async () => {
    use([
      releasesPageRule(1, releases(100)),
      releasesPageRule(2, [rawRelease("v2.0.0", { id: 101 })]),
      releasesLatestRule({ id: 1 }),
    ])
    const result = await run({ method: "list", limit: 100 })
    expect(result.releases?.length).toBe(100)
    expect(result.truncated).toBe(true)
  })

  test("default limit is 30", async () => {
    use([releasesPageRule(1, releases(40)), releasesLatestRule({ id: 1 })])
    const result = await run({ method: "list" })
    expect(result.releases?.length).toBe(30)
    expect(result.truncated).toBe(true)
  })

  test("unknown repository throws not_found", async () => {
    use([restNotFound("releases\\?per_page=100&page=1")])
    const error = await failure(run({ method: "list" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Repository octo/hello was not found, or the viewer cannot see it.")
  })
})

describe("view", () => {
  test("reads a published release by tag with a lightweight tag commit", async () => {
    const installed = use([
      releaseByTagRule(
        "v1.0.0",
        rawRelease("v1.0.0", {
          id: 101,
          assets: [
            {
              name: "asset.tar.gz",
              size: 1024,
              download_count: 5,
              browser_download_url: "https://example.com/asset.tar.gz",
            },
          ],
        }),
      ),
      releasesLatestRule({ id: 101 }),
      gitRefTagRule("v1.0.0", {
        object: { type: "commit", sha: RELEASE_COMMIT },
      }),
    ])
    expect(await run({ method: "view", tag: "v1.0.0" })).toEqual({
      repo: "octo/hello",
      release: expectedRelease("v1.0.0", {
        latest: true,
        tag_exists: true,
        commit: RELEASE_COMMIT,
        assets: [
          {
            name: "asset.tar.gz",
            size: 1024,
            download_count: 5,
            url: "https://example.com/asset.tar.gz",
          },
        ],
      }),
    })
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases/tags/v1.0.0",
      "repos/octo/hello/releases/latest",
      "repos/octo/hello/git/ref/tags/v1.0.0",
    ])
  })

  test("draft found by scanning after tags endpoint returns 404", async () => {
    const installed = use([
      restNotFound("releases/tags/v2.0.0"),
      releasesPageRule(1, [
        rawRelease("v1.0.0", { id: 100 }),
        rawRelease("v2.0.0", { id: 200, draft: true, published_at: null, target_commitish: "main" }),
      ]),
      releasesLatestRule({ id: 100 }),
      restNotFound("git/ref/tags/v2.0.0"),
      branchRule("main", "main-head-sha"),
    ])
    const result = await run({ method: "view", tag: "v2.0.0" })
    expect(result.release).toEqual(
      expectedRelease("v2.0.0", {
        draft: true,
        published_at: null,
        latest: false,
        tag_exists: false,
        commit: "main-head-sha",
      }),
    )
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases/tags/v2.0.0",
      "repos/octo/hello/releases?per_page=100&page=1",
      "repos/octo/hello/releases/latest",
      "repos/octo/hello/git/ref/tags/v2.0.0",
      "repos/octo/hello/branches/main",
    ])
  })

  test("missing release throws not_found with the repository message", async () => {
    use([restNotFound("releases/tags/v9.9.9"), releasesPageRule(1, [])])
    const error = await failure(run({ method: "view", tag: "v9.9.9" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Release v9.9.9 was not found in octo/hello, or the viewer cannot see it.")
  })

  test("peels annotated tags until a commit is reached", async () => {
    use([
      releaseByTagRule("v1.0.0", rawRelease("v1.0.0", { id: 100 })),
      releasesLatestRule(null),
      gitRefTagRule("v1.0.0", { object: { type: "tag", sha: "annotated-tag-sha" } }),
      gitTagRule("annotated-tag-sha", { object: { type: "commit", sha: "peeled-commit-sha" } }),
    ])
    const result = await run({ method: "view", tag: "v1.0.0" })
    expect(result.release?.tag_exists).toBe(true)
    expect(result.release?.commit).toBe("peeled-commit-sha")
  })

  test("draft without a tag with a SHA target uses target itself", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567"
    use([
      releaseByTagRule("v1.0.0", rawRelease("v1.0.0", { id: 100, target_commitish: sha })),
      releasesLatestRule(null),
      restNotFound("git/ref/tags/v1.0.0"),
    ])
    const result = await run({ method: "view", tag: "v1.0.0" })
    expect(result.release?.tag_exists).toBe(false)
    expect(result.release?.commit).toBe(sha)
  })

  test("draft without a tag with a branch target reads branchHead", async () => {
    use([
      releaseByTagRule("v1.0.0", rawRelease("v1.0.0", { id: 100, target_commitish: "feature/foo" })),
      releasesLatestRule(null),
      restNotFound("git/ref/tags/v1.0.0"),
      branchRule("feature/foo", "feature-head-sha"),
    ])
    const result = await run({ method: "view", tag: "v1.0.0" })
    expect(result.release?.tag_exists).toBe(false)
    expect(result.release?.commit).toBe("feature-head-sha")
  })

  test("draft without a tag with a deleted branch returns null commit", async () => {
    use([
      releaseByTagRule("v1.0.0", rawRelease("v1.0.0", { id: 100, target_commitish: "deleted-branch" })),
      releasesLatestRule(null),
      restNotFound("git/ref/tags/v1.0.0"),
      restNotFound("branches/deleted-branch"),
    ])
    const result = await run({ method: "view", tag: "v1.0.0" })
    expect(result.release?.tag_exists).toBe(false)
    expect(result.release?.commit).toBeNull()
  })

  test("tag with a slash is encoded per segment", async () => {
    const installed = use([
      releaseByTagRule("release/v1.0", rawRelease("release/v1.0", { id: 100 })),
      releasesLatestRule(null),
      gitRefTagRule("release/v1.0", { object: { type: "commit", sha: "slash-tag-sha" } }),
    ])
    const result = await run({ method: "view", tag: "release/v1.0" })
    expect(result.release?.tag).toBe("release/v1.0")
    expect(restPaths(installed)).toEqual([
      "repos/octo/hello/releases/tags/release/v1.0",
      "repos/octo/hello/releases/latest",
      "repos/octo/hello/git/ref/tags/release/v1.0",
    ])
  })
})

describe("refusals", () => {
  test("refuses limit with method view", async () => {
    const error = await failure(run({ method: "view", tag: "v1.0.0", limit: 10 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"limit" is an argument of method "list", not "view"; leave it out.')
  })

  test("refuses tag with method list", async () => {
    const error = await failure(run({ method: "list", tag: "v1.0.0" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"tag" is an argument of method "view", not "list"; leave it out.')
  })

  test("refuses view without tag", async () => {
    const error = await failure(run({ method: "view" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('method "view" needs `tag`, the release\'s git tag.')
  })
})
