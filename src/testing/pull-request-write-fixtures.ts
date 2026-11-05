import type { FakeGh, GhRule } from "./fake-gh"
import { gqlReply } from "./gql"
import { sent } from "./write-fixtures"

/** Replies of GitHub the pull request write tools meet, and a view of the `gh pr` calls a fake `gh` saw. */

/** A token only the pull request state query holds, so a fake `gh` rule can pick it. */
export const STATE = "headRefOid\\s+closingIssuesReferences"

/** A pull request as the state query replies with it: pull request 7 of `octo/hello`, open, into `main` from `feature`. */
export const rawPullRequestState = (extra: Record<string, unknown> = {}) => ({
  id: "PR_7",
  number: 7,
  url: "https://github.com/octo/hello/pull/7",
  state: "OPEN",
  isDraft: false,
  author: { login: "someone" },
  body: "",
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
  closingIssuesReferences: { nodes: [] },
  ...extra,
})

/** An issue a pull request closes, as the state query replies with it. */
export const rawClosingIssue = (number: number, repo = "octo/hello") => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state: "OPEN",
  repository: { nameWithOwner: repo },
})

/** The part of the state reply that says GitHub links these issues as closed by the pull request. */
export const linkedIssues = (...issues: ReturnType<typeof rawClosingIssue>[]) => ({
  closingIssuesReferences: { nodes: issues },
})

export const stateRule = (extra: Record<string, unknown> = {}, times?: number): GhRule => ({
  match: STATE,
  stdout: gqlReply({ repository: { pullRequest: rawPullRequestState(extra) } }),
  times,
})

/** The state query finds no such pull request. */
export const noPullRequestRule = (): GhRule => ({
  match: STATE,
  stdout: gqlReply({ repository: { pullRequest: null } }),
})

/** What `gh pr create` prints: the new pull request's URL. */
export const prCreatedRule = (number: number, repo = "octo/hello"): GhRule => ({
  match: "^pr create",
  stdout: `https://github.com/${repo}/pull/${number}\n`,
})

/** What `gh pr edit` prints: the pull request's URL. */
export const prEditedRule = (number: number, repo = "octo/hello"): GhRule => ({
  match: "^pr edit",
  stdout: `https://github.com/${repo}/pull/${number}\n`,
})

/** The `gh pr` calls with their stdin, in order. */
export function prCommands(installed: FakeGh): { args: string[]; stdin: string }[] {
  const stdins = installed.stdins()
  return installed.calls().flatMap((args, index) => (args[0] === "pr" ? [{ args, stdin: stdins[index] ?? "" }] : []))
}

/** The `gh pr` calls that change something: every one but `pr list`. */
export const prWrites = (installed: FakeGh): string[][] =>
  sent(installed).filter((args) => args[0] === "pr" && args[1] !== "list")

/** The commit SHA the state query fixture places pull request 7 at. */
export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"

/** What `gh api` review creation prints: the new review's URL. */
export const REVIEW_URL = "https://github.com/octo/hello/pull/7#pullrequestreview-101"

/** A reply of GitHub to `POST repos/<owner>/<name>/pulls/<n>/reviews`. */
export function reviewPostRule(
  options: {
    id?: number
    state?: string
    commit_id?: string
    url?: string
    stderr?: string
    code?: number
  } = {},
): GhRule {
  if (options.stderr) {
    return {
      match: "^api -X POST repos/[^/]+/[^/]+/pulls/\\d+/reviews",
      stderr: options.stderr,
      code: options.code ?? 1,
    }
  }
  return {
    match: "^api -X POST repos/[^/]+/[^/]+/pulls/\\d+/reviews",
    stdout: JSON.stringify({
      id: options.id ?? 101,
      state: options.state ?? "APPROVED",
      html_url: options.url ?? REVIEW_URL,
      commit_id: options.commit_id ?? COMMIT_SHA,
    }),
  }
}

/** The `gh api` calls that post a review, with their stdin parsed as JSON. */
export function reviewPosts(installed: FakeGh): { args: string[]; stdin: Record<string, unknown> }[] {
  const stdins = installed.stdins()
  const calls = installed.calls()
  return calls.flatMap((args, index) =>
    args[0] === "api" && args.includes("POST")
      ? [{ args, stdin: JSON.parse(stdins[index] ?? "{}") as Record<string, unknown> }]
      : [],
  )
}
