import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { repositoryViewRule } from "../../testing/repos-fixtures"
import { ORIGIN } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { repoArchive } from "./repo-archive"
import { repoUnarchive } from "./repo-unarchive"
import { repoVisibility } from "./repo-visibility"

/** One call of a repository write tool to describe, and the replies of GitHub it meets. */
export type DescribeCase = { name: string; tool: ToolSpec; args: Record<string, unknown>; rules: GhRule[] }

/** The reply of GitHub for `octo/hello` with `extra` laid over, as the only read a repository call makes. */
export const repoRules = (extra: Record<string, unknown> = {}): GhRule[] => [repositoryViewRule(extra)]

const visibilityCase = (from: string, to: string) => ({
  name: `make a ${from.toLowerCase()} repository ${to}`,
  tool: repoVisibility,
  args: { visibility: to },
  rules: repoRules({ visibility: from }),
})

/** Representative calls of the repository write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  archive: {
    name: "archive a public repository",
    tool: repoArchive,
    args: {},
    rules: repoRules(),
  },
  archivePrivate: {
    name: "archive a private repository named by owner/name",
    tool: repoArchive,
    args: { repo: "octo/hello" },
    rules: repoRules({ visibility: "PRIVATE" }),
  },
  archiveInternal: {
    name: "archive an internal repository",
    tool: repoArchive,
    args: {},
    rules: repoRules({ visibility: "INTERNAL" }),
  },
  unarchive: {
    name: "unarchive a repository",
    tool: repoUnarchive,
    args: {},
    rules: repoRules({ isArchived: true }),
  },
  unarchiveActive: {
    name: "unarchive a repository that is not archived",
    tool: repoUnarchive,
    args: {},
    rules: repoRules(),
  },
  publicToPrivate: visibilityCase("PUBLIC", "private"),
  publicToInternal: visibilityCase("PUBLIC", "internal"),
  privateToPublic: visibilityCase("PRIVATE", "public"),
  privateToInternal: visibilityCase("PRIVATE", "internal"),
  internalToPublic: visibilityCase("INTERNAL", "public"),
  internalToPrivate: visibilityCase("INTERNAL", "private"),
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
