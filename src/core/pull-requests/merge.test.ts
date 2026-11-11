import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import {
  ALL_METHODS,
  headSha,
  mergePollRule,
  mergePutFailureRule,
  mergePutRule,
  mergePuts,
  mergeReply,
  mergeSha,
  mergeStateRule,
  mergedState,
  mergingRules,
  methodsRule,
} from "../../testing/merge-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prMerge } from "./merge"

const { use, run } = writeHarness(prMerge)

/** A pull request 7 that merges at once: it reads open, then merged, and the merge request is answered `merged`. */
const merges = (...methods: Parameters<typeof methodsRule>): GhRule[] => [
  repositoryRule(),
  methodsRule(...methods),
  ...mergingRules(7),
  mergePutRule(7, mergeReply("merged")),
]

const MERGED_RESULT = {
  repo: "octo/hello",
  pr: 7,
  method: "squash" as "squash" | null,
  status: "merged" as const,
  merged: [{ number: 7, state: "merged", merge_commit: mergeSha(7) }],
  request: null,
  branches: [],
  changed: true,
  notes: [],
  foreign: false,
  errors: {},
}

describe("the merge request", () => {
  test("squash: the result, and the one PUT with the head that was read", async () => {
    const installed = use(merges("squash"))
    expect(await run({ pr: "7" })).toEqual(MERGED_RESULT)
    expect(mergePuts(installed)).toEqual([
      {
        path: "repos/octo/hello/pulls/7/merge-async",
        body: { merge_method: "squash", sha: headSha(7) },
      },
    ])
    expect(sent(installed).find((args) => args.includes("PUT"))).toContain("X-GitHub-Api-Version: 2026-03-10")
  })

  test.each(ALL_METHODS)("%s: the body holds the method and the head alone", async (method) => {
    const installed = use(merges(...ALL_METHODS))
    expect(await run({ pr: "7", method })).toMatchObject({ method, status: "merged" })
    expect(mergePuts(installed).map((put) => put.body)).toEqual([{ merge_method: method, sha: headSha(7) }])
  })

  test.each(["merge", "squash"] as const)(
    "%s: subject and body become the commit's title and message",
    async (method) => {
      const installed = use(merges(...ALL_METHODS))
      await run({ pr: "7", method, subject: " Add the thing (#7) ", body: "Why it was needed." })
      expect(mergePuts(installed).map((put) => put.body)).toEqual([
        {
          merge_method: method,
          sha: headSha(7),
          commit_title: "Add the thing (#7)",
          commit_message: "Why it was needed.",
        },
      ])
    },
  )

  test("a body without a subject is sent alone", async () => {
    const installed = use(merges(...ALL_METHODS))
    await run({ pr: "7", method: "merge", body: "Only a message." })
    expect(mergePuts(installed).map((put) => put.body)).toEqual([
      { merge_method: "merge", sha: headSha(7), commit_message: "Only a message." },
    ])
  })

  test("a blank subject and body are not sent", async () => {
    const installed = use(merges(...ALL_METHODS))
    await run({ pr: "7", method: "merge", subject: "  ", body: "" })
    expect(mergePuts(installed).map((put) => put.body)).toEqual([{ merge_method: "merge", sha: headSha(7) }])
  })

  test("a repository of someone else is foreign", async () => {
    use([repositoryRule({ viewer: "me" }), ...merges("squash").slice(1)])
    expect((await run({ pr: "7" })).foreign).toBe(true)
  })

  test("a pull request URL names its own repository", async () => {
    const installed = use([
      repositoryRule({ repo: "other/thing" }),
      methodsRule("squash"),
      ...mergingRules(7),
      mergePutRule(7, mergeReply("merged")),
    ])
    await run({ pr: "https://github.com/other/thing/pull/7" })
    expect(mergePuts(installed)[0]!.path).toBe("repos/other/thing/pulls/7/merge-async")
  })
})

describe("the method", () => {
  test("left out, it is the one the repository allows", async () => {
    const installed = use(merges("rebase"))
    expect(await run({ pr: "7" })).toMatchObject({ method: "rebase" })
    expect(mergePuts(installed)[0]!.body.merge_method).toBe("rebase")
  })

  test("left out when several are allowed, it is invalid_argument naming them, and nothing is sent", async () => {
    const installed = use(merges("merge", "squash"))
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("pass method: one of merge, squash")
    expect(mergePuts(installed)).toEqual([])
  })

  test("one the repository does not allow is invalid_argument listing the allowed ones", async () => {
    const installed = use(merges("merge", "squash"))
    const error = await failure(run({ pr: "7", method: "rebase" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("does not allow rebase merges")
    expect(error.message).toContain("merge, squash")
    expect(mergePuts(installed)).toEqual([])
  })

  test("a repository that allows none is invalid_argument", async () => {
    use(merges())
    expect((await failure(run({ pr: "7" }))).code).toBe("invalid_argument")
  })

  test.each([{ subject: "A title" }, { body: "A message" }])(
    "rebase with %o is refused before anything is read",
    async (args) => {
      const installed = use(merges(...ALL_METHODS))
      const error = await failure(run({ pr: "7", method: "rebase", ...args }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("a rebase makes no merge commit")
      expect(sent(installed)).toEqual([])
    },
  )

  test("a rebase that is the only method allowed refuses subject too, and nothing is sent", async () => {
    const installed = use(merges("rebase"))
    expect((await failure(run({ pr: "7", subject: "A title" }))).code).toBe("invalid_argument")
    expect(mergePuts(installed)).toEqual([])
  })
})

describe("refusals before any write", () => {
  test("a merged pull request is left as it is: changed is false, nothing is sent", async () => {
    const installed = use([repositoryRule(), methodsRule("squash"), mergeStateRule(7, mergedState(7))])
    expect(await run({ pr: "7" })).toEqual({ ...MERGED_RESULT, method: null, changed: false })
    expect(mergePuts(installed)).toEqual([])
  })

  test("a merged pull request reports the method that was asked", async () => {
    use([repositoryRule(), mergeStateRule(7, mergedState(7))])
    expect(await run({ pr: "7", method: "merge" })).toMatchObject({ method: "merge", changed: false })
  })

  test.each([
    ["closed", { state: "CLOSED" }, "octo/hello#7 is closed; reopen it with github_pr_reopen first."],
    ["a draft", { isDraft: true }, "octo/hello#7 is a draft; mark it ready with github_pr_ready first."],
    ["conflicting", { mergeable: "CONFLICTING" }, "octo/hello#7 has conflicts with main"],
    ["dirty", { mergeStateStatus: "DIRTY" }, "octo/hello#7 has conflicts with main"],
  ])("%s is invalid_argument, and nothing is sent", async (_, state, message) => {
    const installed = use([repositoryRule(), methodsRule("squash"), mergeStateRule(7, state), mergePutRule(7)])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(mergePuts(installed)).toEqual([])
  })

  test.each([
    ["blocked", { mergeStateStatus: "BLOCKED" }],
    ["behind", { mergeStateStatus: "BEHIND" }],
    ["unstable", { mergeStateStatus: "UNSTABLE" }],
    ["unknown", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }],
  ])("%s is left to GitHub: the request is sent", async (_, state) => {
    const installed = use([
      repositoryRule(),
      methodsRule("squash"),
      mergeStateRule(7, state, 1),
      mergeStateRule(7, mergedState(7)),
      mergePutRule(7, mergeReply("merged")),
    ])
    expect(await run({ pr: "7" })).toMatchObject({ status: "merged", changed: true })
    expect(mergePuts(installed)).toHaveLength(1)
  })

  test("a head_sha that is not a commit SHA is invalid_argument, before anything is read", async () => {
    const installed = use(merges("squash"))
    expect((await failure(run({ pr: "7", head_sha: "abc" }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a head_sha that differs is stale, and nothing is merged", async () => {
    const installed = use(merges("squash"))
    const error = await failure(run({ pr: "7", head_sha: headSha(8) }))
    expect(error.code).toBe("stale")
    expect(error.message).toContain("new commits arrived")
    expect(error.message).toContain("Nothing was merged.")
    expect(mergePuts(installed)).toEqual([])
  })

  test("a head_sha that matches, whatever its case, merges that head", async () => {
    const installed = use(merges("squash"))
    await run({ pr: "7", head_sha: headSha(7).toUpperCase() })
    expect(mergePuts(installed)[0]!.body.sha).toBe(headSha(7))
  })

  test("without write permission it is forbidden, and nothing is read or sent", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), ...merges("squash").slice(1)])
    expect((await failure(run({ pr: "7" }))).code).toBe("forbidden")
    expect(sent(installed).filter((args) => args.includes("merge-async"))).toEqual([])
  })

  test("a pull request that does not exist is not_found", async () => {
    use([
      repositoryRule(),
      { match: "mergeCommit\\{oid\\}", stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) },
    ])
    expect((await failure(run({ pr: "7" }))).code).toBe("not_found")
  })

  test("an issue URL is invalid_argument", async () => {
    use(merges("squash"))
    expect((await failure(run({ pr: "https://github.com/octo/hello/issues/7" }))).code).toBe("invalid_argument")
  })
})

describe("another merge of the pull request is pending", () => {
  const conflict = [repositoryRule(), methodsRule("squash"), mergePutFailureRule(7, "Conflict (HTTP 409)")]

  test("it has merged by now: the call goes on, changed is false and no request is named", async () => {
    use([...conflict.slice(0, 2), ...mergingRules(7), conflict[2]!])
    expect(await run({ pr: "7" })).toEqual({ ...MERGED_RESULT, changed: false })
  })

  test("it has not: stale, asking to read the pull request again", async () => {
    use([...conflict, mergeStateRule(7)])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("stale")
    expect(error.message).toBe(
      "Another merge of octo/hello#7 is already running; read it again with github_pr_read view.",
    )
  })

  test("the head moved meanwhile: stale, naming the new commits", async () => {
    use([...conflict, mergeStateRule(7, {}, 1), mergeStateRule(7, { headRefOid: headSha(8) })])
    const error = await failure(run({ pr: "7" }))
    expect(error.code).toBe("stale")
    expect(error.message).toContain("new commits arrived")
  })

  test("another failure of the request is thrown as it is", async () => {
    use([
      repositoryRule(),
      methodsRule("squash"),
      mergeStateRule(7),
      mergePutFailureRule(7, "Method Not Allowed (HTTP 405)"),
    ])
    expect((await failure(run({ pr: "7" }))).code).toBe("upstream_error")
  })
})

test("the merge request is polled by the ID GitHub gave", async () => {
  const installed = use([
    repositoryRule(),
    methodsRule("squash"),
    ...mergingRules(7),
    mergePutRule(7),
    mergePollRule(7, mergeReply("merged")),
  ])
  expect(await run({ pr: "7" })).toMatchObject({ status: "merged", request: "uuid-1" })
  const polls = sent(installed).filter((args) => args.some((arg) => arg.endsWith("/merge-async/uuid-1")))
  expect(polls).toHaveLength(1)
})
