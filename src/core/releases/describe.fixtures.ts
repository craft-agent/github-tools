import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import {
  RELEASE_COMMIT,
  branchRule,
  rawRelease,
  releaseByTagRule,
  releasesLatestRule,
  releasesPageRule,
  restNotFound,
} from "../../testing/releases-fixtures"
import { ORIGIN, repositoryRule } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { releaseCreate } from "./release-create"
import { releaseEdit } from "./release-edit"

/** One call of a release write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The commit the branch `main` has in the cases that publish a draft. */
export const BRANCH_SHA = "1111111111222222222233333333334444444444"

/** The tag the cases are about, and a draft and a published release of it. */
export const TAG = "v1.0.0"

/** The replies for a release that does not exist: no release by its tag, none among the drafts. */
export const noReleaseRules = (tag: string): GhRule[] => [releaseByTagRule(tag, null), releasesPageRule(1, [])]

/** The replies for a call on the published release `TAG` as `rawRelease(TAG, extra)`. */
export const publishedRules = (extra: Record<string, unknown> = {}): GhRule[] => [
  repositoryRule(),
  releaseByTagRule(TAG, rawRelease(TAG, extra)),
]

/** The replies for a call on the draft release `TAG` as `rawRelease(TAG, extra)`, which GitHub finds among the listed releases. */
export const draftRules = (extra: Record<string, unknown> = {}): GhRule[] => [
  repositoryRule(),
  releaseByTagRule(TAG, null),
  releasesPageRule(1, [rawRelease(TAG, { draft: true, published_at: null, ...extra })]),
]

/** Representative calls of the release write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  createDefaults: {
    name: "create a release with just a tag",
    tool: releaseCreate,
    args: { tag: "v2.0.0" },
    rules: [repositoryRule(), ...noReleaseRules("v2.0.0")],
  },
  createFull: {
    name: "create a release with every piece, from a branch",
    tool: releaseCreate,
    args: {
      tag: "v2.0.0",
      target: "main",
      title: "Two",
      notes: "What is new",
      generate_notes: true,
      prerelease: true,
    },
    rules: [
      repositoryRule(),
      ...noReleaseRules("v2.0.0"),
      restNotFound("git/ref/tags/v2.0.0"),
      branchRule("main", BRANCH_SHA),
    ],
  },
  createFromCommit: {
    name: "create a release from a commit, as a final release",
    tool: releaseCreate,
    args: { tag: "v2.0.0", target: RELEASE_COMMIT, prerelease: false },
    rules: [repositoryRule(), ...noReleaseRules("v2.0.0"), restNotFound("git/ref/tags/v2.0.0")],
  },
  editPublished: {
    name: "edit the title, notes and prerelease flag of a published release",
    tool: releaseEdit,
    args: { tag: TAG, title: "Renamed", notes: "New notes", prerelease: true },
    rules: publishedRules(),
  },
  editClearNotes: {
    name: "clear the notes of a published release",
    tool: releaseEdit,
    args: { tag: TAG, notes: "" },
    rules: publishedRules(),
  },
  editLatest: {
    name: "make a published release the latest",
    tool: releaseEdit,
    args: { tag: TAG, latest: true },
    rules: [...publishedRules(), releasesLatestRule({ id: 999 })],
  },
  editNotLatest: {
    name: "stop a published release being the latest",
    tool: releaseEdit,
    args: { tag: TAG, latest: false },
    rules: [...publishedRules(), releasesLatestRule({ id: 101 })],
  },
  editDraft: {
    name: "clear the title of a draft and move its target",
    tool: releaseEdit,
    args: { tag: TAG, title: "", target: "dev" },
    rules: [...draftRules(), restNotFound("git/ref/tags/v1.0.0"), branchRule("dev", BRANCH_SHA)],
  },
  editNothing: {
    name: "edit a release to what it is already",
    tool: releaseEdit,
    args: { tag: TAG, title: "Release v1.0.0", notes: "Notes for v1.0.0", prerelease: false },
    rules: publishedRules(),
  },
} satisfies Record<string, DescribeCase>

/**
 * Describes a case in a throwaway working tree whose origin is `octo/hello`,
 * with the fake `gh` it needs; `seen` gets the arguments of every call the
 * description made to `gh`.
 */
export async function describeCase(
  item: DescribeCase,
  seen?: (calls: string[][]) => void,
): Promise<CallDescription | undefined> {
  const repo = tempRepo(ORIGIN)
  const fake = installFakeGh(item.rules)
  try {
    return await callDescription(item.tool, item.args, { cwd: repo.dir })
  } finally {
    seen?.(fake.calls())
    fake.restore()
    repo.cleanup()
  }
}
