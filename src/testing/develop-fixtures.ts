import type { GhRule } from "./fake-gh"
import { gqlReply } from "./gql"

/** Replies of GitHub for the tests of the develop tool. */

/** Each is a token only one of the queries holds, so a fake `gh` rule can pick it. */
export const LINKED_BRANCHES = "linkedBranches\\(first:100\\)"
export const DEFAULT_BRANCH = "defaultBranchRef"
export const CREATE_LINKED_BRANCH = "createLinkedBranch"

/** The node id of issue 12, and the commit every branch of the fake points at. */
export const ISSUE_ID = "I_12"
export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"

export type Linked = { name: string; repo?: string }

/** The linked-branches read; `times` limits how many reads it answers. */
export const linkedBranchesRule = (branches: Linked[] = [], times?: number): GhRule => ({
  match: LINKED_BRANCHES,
  times,
  stdout: gqlReply({
    repository: {
      issue: {
        id: ISSUE_ID,
        linkedBranches: {
          nodes: [
            ...branches.map((branch) => ({
              ref: { name: branch.name, repository: { nameWithOwner: branch.repo ?? "octo/hello" } },
            })),
            { ref: null },
          ],
        },
      },
    },
  }),
})

/** The default-branch read of any repository, or only of the one whose owner is `owner`. */
export const defaultBranchRule = (name: string | null, owner?: string): GhRule => ({
  match: owner === undefined ? DEFAULT_BRANCH : `${DEFAULT_BRANCH}[\\s\\S]*owner=${owner} `,
  stdout: gqlReply({ repository: { defaultBranchRef: name === null ? null : { name } } }),
})

/** The REST read of one branch, `branch` spelled as in the path: it points at `HEAD_SHA`, or GitHub says 404. */
export const branchRule = (repo: string, branch: string, exists: boolean): GhRule => ({
  match: `^api repos/${repo}/branches/${branch}$`,
  ...(exists
    ? { stdout: JSON.stringify({ name: branch, commit: { sha: HEAD_SHA } }) }
    : { stderr: "gh: Not Found (HTTP 404)", code: 1 }),
})

/** What the `createLinkedBranch` mutation replies: the branch it made. */
export const createdBranchRule = (name: string, repo = "octo/hello"): GhRule => ({
  match: CREATE_LINKED_BRANCH,
  stdout: gqlReply({
    createLinkedBranch: { linkedBranch: { ref: { name, repository: { nameWithOwner: repo } } } },
  }),
})
