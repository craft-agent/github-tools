import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { repositoryViewRule, restFailure, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { repoEdit } from "./repo-edit"

const { use, run } = writeHarness(repoEdit)
const patched = { match: "-X PATCH" }
const topicsPut = { match: "-X PUT" }
const branchDev = { match: "branches/dev", stdout: JSON.stringify({ commit: { sha: "a".repeat(40) } }) }

/** The view of `octo/hello` (with `extra`), then the rules every edit meets. */
const rules = (extra: Record<string, unknown> = {}) => [
  repositoryViewRule(extra),
  repositoryRule(),
  patched,
  topicsPut,
  branchDev,
]

const PATCH_ARGS = ["api", "-X", "PATCH", "repos/octo/hello", "--input", "-"]
const PUT_ARGS = ["api", "-X", "PUT", "repos/octo/hello/topics", "--input", "-"]

describe("the writes", () => {
  test("only what differs is sent: one PATCH of the fields, one PUT of the topics", async () => {
    const installed = use(rules())
    const result = await run({
      description: "New text",
      homepage: "https://hello.example",
      has_issues: true,
      has_wiki: true,
      allow_squash_merge: false,
      delete_branch_on_merge: false,
      add_topics: ["Rust", "cli"],
      remove_topics: ["git"],
    })
    expect(result).toEqual({
      repo: "octo/hello",
      changed: ["description", "has_wiki", "allow_squash_merge", "delete_branch_on_merge", "topics"],
      foreign: false,
    })
    expect(writeLog(installed)).toEqual([
      {
        args: PATCH_ARGS,
        body: { description: "New text", has_wiki: true, allow_squash_merge: false, delete_branch_on_merge: false },
      },
      { args: PUT_ARGS, body: { names: ["cli", "rust"] } },
    ])
  })

  test("settings alone send no topics", async () => {
    const installed = use(rules())
    expect((await run({ is_template: true, has_discussions: true, allow_update_branch: true })).changed).toEqual([
      "has_discussions",
      "allow_update_branch",
      "is_template",
    ])
    expect(writeLog(installed)).toEqual([
      { args: PATCH_ARGS, body: { has_discussions: true, allow_update_branch: true, is_template: true } },
    ])
  })

  test("topics alone send no PATCH", async () => {
    const installed = use(rules())
    expect((await run({ remove_topics: ["cli"] })).changed).toEqual(["topics"])
    expect(writeLog(installed)).toEqual([{ args: PUT_ARGS, body: { names: ["git"] } }])
  })

  test("an empty description and homepage clear them", async () => {
    const installed = use(rules())
    expect((await run({ description: "", homepage: "" })).changed).toEqual(["description", "homepage"])
    expect(writeLog(installed)[0]!.body).toEqual({ description: "", homepage: "" })
  })

  test("a branch that exists becomes the default", async () => {
    const installed = use(rules())
    expect((await run({ default_branch: "dev" })).changed).toEqual(["default_branch"])
    expect(writeLog(installed)).toEqual([{ args: PATCH_ARGS, body: { default_branch: "dev" } }])
  })

  test("another repository is foreign", async () => {
    const installed = use([
      repositoryViewRule({ nameWithOwner: "other/thing" }),
      repositoryRule({ repo: "other/thing", viewer: "me" }),
      patched,
    ])
    expect(await run({ repo: "other/thing", has_wiki: true })).toEqual({
      repo: "other/thing",
      changed: ["has_wiki"],
      foreign: true,
    })
    expect(writeLog(installed)[0]!.args).toContain("repos/other/thing")
  })
})

describe("nothing to change", () => {
  test("values equal to the current ones and topics already as asked send no write", async () => {
    const installed = use(rules())
    expect(
      await run({
        description: "Says hello",
        default_branch: "main",
        has_issues: true,
        allow_rebase_merge: false,
        add_topics: ["CLI"],
        remove_topics: ["absent"],
      }),
    ).toEqual({ repo: "octo/hello", changed: [], foreign: false })
    expect(writeLog(installed)).toEqual([])
  })

  test("an empty topic list changes nothing either", async () => {
    const installed = use(rules())
    expect((await run({ add_topics: [] })).changed).toEqual([])
    expect(writeLog(installed)).toEqual([])
  })
})

describe("topics", () => {
  test("are trimmed, lowercased and deduplicated", async () => {
    const installed = use(rules({ repositoryTopics: { nodes: [] } }))
    await run({ add_topics: [" Machine-Learning ", "machine-learning", "A1"] })
    expect(writeLog(installed)[0]!.body).toEqual({ names: ["machine-learning", "a1"] })
  })

  test("a removal is matched without regard to case", async () => {
    const installed = use(rules())
    await run({ remove_topics: ["GIT"] })
    expect(writeLog(installed)[0]!.body).toEqual({ names: ["cli"] })
  })

  test("the longest valid topic is accepted", async () => {
    const installed = use(rules())
    await run({ add_topics: ["a".repeat(50)] })
    expect(writeLog(installed)[0]!.body).toEqual({ names: ["cli", "git", "a".repeat(50)] })
  })

  test.each([["Bad Topic"], ["-leading"], ["under_score"], ["a".repeat(51)], [" "]])(
    "%p is refused without writing",
    async (topic) => {
      const installed = use(rules())
      const error = await failure(run({ add_topics: [topic] }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toStartWith(`add_topics: "${topic.trim().toLowerCase()}" is not a topic;`)
      expect(writeLog(installed)).toEqual([])
    },
  )

  test("a topic to remove is checked too", async () => {
    use(rules())
    expect((await failure(run({ remove_topics: ["no way"] }))).message).toStartWith('remove_topics: "no way"')
  })

  test("the same topic in both lists is refused", async () => {
    const installed = use(rules())
    const error = await failure(run({ add_topics: ["Rust"], remove_topics: ["rust"] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('The topic "rust" is in both add_topics and remove_topics.')
    expect(writeLog(installed)).toEqual([])
  })
})

describe("the merge methods", () => {
  test("turning every one off is refused without writing", async () => {
    const installed = use(rules())
    const error = await failure(run({ allow_merge_commit: false, allow_squash_merge: false }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "That would turn off every merge method of octo/hello; keep at least one of allow_merge_commit, allow_squash_merge, allow_rebase_merge on.",
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("turning one off while another stays on is allowed", async () => {
    const installed = use(rules())
    await run({ allow_merge_commit: false })
    expect(writeLog(installed)[0]!.body).toEqual({ allow_merge_commit: false })
  })

  test("turning one on while the others go off is allowed", async () => {
    const installed = use(rules())
    await run({ allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false })
    expect(writeLog(installed)[0]!.body).toEqual({
      allow_merge_commit: false,
      allow_squash_merge: false,
      allow_rebase_merge: true,
    })
  })

  test("a repository with none on is not blocked from an unrelated edit", async () => {
    const installed = use(rules({ mergeCommitAllowed: false, squashMergeAllowed: false }))
    await run({ has_wiki: true })
    expect(writeLog(installed)[0]!.body).toEqual({ has_wiki: true })
  })
})

describe("refusals", () => {
  test("no change argument", async () => {
    const installed = use(rules())
    const error = await failure(run({ repo: "octo/hello" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("Pass at least one setting to change, or topics to add or remove.")
    expect(writeLog(installed)).toEqual([])
  })

  test("an archived repository points at github_repo_unarchive", async () => {
    const installed = use(rules({ isArchived: true }))
    const error = await failure(run({ has_wiki: true }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "octo/hello is archived, so its settings cannot change; unarchive it with github_repo_unarchive first.",
    )
    expect(writeLog(installed)).toEqual([])
  })

  test.each(["WRITE", "MAINTAIN", null])("permission %p is not admin", async (permission) => {
    const installed = use(rules({ viewerPermission: permission }))
    const error = await failure(run({ has_wiki: true }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("No admin permission on octo/hello")
    expect(writeLog(installed)).toEqual([])
  })

  test("a default branch that does not exist", async () => {
    const installed = use([restFailure("branches/nope", "Not Found (HTTP 404)"), ...rules()])
    const error = await failure(run({ default_branch: "nope" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('octo/hello has no branch "nope" to make the default; push it first.')
    expect(writeLog(installed)).toEqual([])
  })

  test.each([{ default_branch: "" }, { has_wiki: "yes" }, { add_topics: "cli" }, { unknown: true }])(
    "invalid arguments %p send no write",
    async (args) => {
      const installed = use(rules())
      expect((await failure(run(args))).code).toBe("invalid_argument")
      expect(writeLog(installed)).toEqual([])
    },
  )
})
