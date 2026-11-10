import { installFakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import {
  rawRuleset,
  repositoryFactsRule,
  repositoryOwnerRule,
  repositoryViewRule,
  rulesetGetRule,
  rulesetListRule,
} from "../../testing/repos-fixtures"
import { ORIGIN } from "../../testing/write-fixtures"
import { callDescription } from "../describe"
import type { CallDescription, ToolSpec } from "../tool"
import { repoArchive } from "./repo-archive"
import { repoCreate } from "./repo-create"
import { repoEdit } from "./repo-edit"
import { repoUnarchive } from "./repo-unarchive"
import { repoVisibility } from "./repo-visibility"
import { rulesetCreate } from "./ruleset-create"

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

/** The replies for creating `full` under `owner` (an organization unless `type` says otherwise): the owner exists and the repository does not. */
export const createRules = (
  full: string,
  owner: Parameters<typeof repositoryOwnerRule>[1] = { type: "Organization" },
): GhRule[] => [repositoryOwnerRule(full.split("/")[0]!, owner), repositoryFactsRule(full, null)]

/** The reply of GitHub for a branch `branch` that exists. */
export const branchRule = (branch: string): GhRule => ({
  match: `branches/${branch}`,
  stdout: JSON.stringify({ commit: { sha: "a".repeat(40) } }),
})

const TEMPLATE = "octo/hello-template"

/** The `updated_at` of the ruleset `rawRuleset()` makes. */
export const RULESET_UPDATED_AT = rawRuleset().updated_at

/** The replies for a call on the ruleset 7 (`rawRuleset(extra)`) of `octo/hello`, whose repository has `others` besides it. */
export const rulesetRules = (extra: Record<string, unknown> = {}, ...others: unknown[]): GhRule[] => [
  ...repoRules(),
  rulesetGetRule(rawRuleset(extra)),
  rulesetListRule(rawRuleset(extra), ...others),
]

/** Representative calls of the repository write tools, which the description tests and the words test share. */
export const DESCRIBE_CASES = {
  createRulesetDefaults: {
    name: "create a ruleset with the defaults",
    tool: rulesetCreate,
    args: { name: "Guard", rules: [{ type: "deletion" }] },
    rules: [...repoRules(), rulesetListRule()],
  },
  createRulesetFull: {
    name: "create a branch ruleset with every piece",
    tool: rulesetCreate,
    args: {
      name: "Guard",
      target: "branch",
      enforcement: "evaluate",
      include: ["main", "refs/heads/release/*"],
      exclude: ["tmp"],
      rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }],
      bypass: [
        { actor_type: "OrganizationAdmin", actor_id: 1 },
        { actor_type: "Team", actor_id: 9 },
      ],
    },
    rules: [...repoRules(), rulesetListRule(rawRuleset({ name: "Other" }))],
  },
  createRulesetTag: {
    name: "create a tag ruleset with one bypass actor",
    tool: rulesetCreate,
    args: {
      name: "Tags",
      target: "tag",
      include: ["v*"],
      rules: [{ type: "update" }],
      bypass: [{ actor_type: "Team", actor_id: 9 }],
    },
    rules: [...repoRules(), rulesetListRule()],
  },
  createRulesetPush: {
    name: "create a disabled push ruleset",
    tool: rulesetCreate,
    args: { name: "Pushes", target: "push", enforcement: "disabled", rules: [{ type: "file_path_restriction" }] },
    rules: [...repoRules(), rulesetListRule()],
  },
  createPrivate: {
    name: "create a repository, private by default",
    tool: repoCreate,
    args: { repo: "octo/new" },
    rules: createRules("octo/new"),
  },
  createPublic: {
    name: "create a public repository",
    tool: repoCreate,
    args: { repo: "octo/new", visibility: "public" },
    rules: createRules("octo/new"),
  },
  createInternal: {
    name: "create an internal repository in an organization",
    tool: repoCreate,
    args: { repo: "octo/new", visibility: "internal", description: "  Internal tool  " },
    rules: createRules("octo/new"),
  },
  createFromTemplate: {
    name: "create a repository from a template",
    tool: repoCreate,
    args: { repo: "octo/new", template: TEMPLATE, description: "From a template" },
    rules: [...createRules("octo/new"), repositoryFactsRule(TEMPLATE, { isTemplate: true })],
  },
  createWithEverything: {
    name: "create a viewer's repository with every optional piece",
    tool: repoCreate,
    args: {
      repo: "alice/new",
      visibility: "public",
      description: "A tool",
      homepage: "https://tool.example",
      license: "mit",
      gitignore: "Node",
      add_readme: true,
    },
    rules: createRules("alice/new", { viewer: "Alice", type: "User" }),
  },
  editEverything: {
    name: "edit every kind of setting",
    tool: repoEdit,
    args: {
      description: "A new description",
      homepage: "",
      default_branch: "dev",
      add_topics: ["rust", "git"],
      remove_topics: ["cli", "absent"],
      has_issues: false,
      has_wiki: true,
      has_projects: true,
      allow_rebase_merge: true,
      allow_squash_merge: false,
      allow_auto_merge: false,
      allow_update_branch: true,
      is_template: true,
    },
    rules: [...repoRules(), branchRule("dev")],
  },
  editHomepage: {
    name: "edit the homepage",
    tool: repoEdit,
    args: { repo: "octo/hello", homepage: "https://new.example" },
    rules: repoRules(),
  },
  editClearDescription: {
    name: "clear the description",
    tool: repoEdit,
    args: { description: "" },
    rules: repoRules(),
  },
  editTemplateOff: {
    name: "stop being a template",
    tool: repoEdit,
    args: { is_template: false },
    rules: repoRules({ isTemplate: true }),
  },
  editNothing: {
    name: "edit what is in place already",
    tool: repoEdit,
    args: { description: "Says hello", has_issues: true, default_branch: "main", add_topics: ["cli"] },
    rules: repoRules(),
  },
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
