import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { gh, ghJson } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { refusalAsInvalid } from "./refusal"
import { readRepositoryPages } from "./repos"
import { repositoryNotFound } from "./repository"

/** The most classic branch protection rules read; a repository has far fewer. */
const MAX_CLASSIC_RULES = 1000

export const rulesetRowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  target: z.string().describe("What the ruleset applies to: branch, tag or push."),
  enforcement: z.string().describe("active, evaluate (only reported) or disabled."),
  source_type: z.string().describe("Where it is defined: Repository, Organization or Enterprise."),
  source: z.string().describe("The repository, organization or enterprise that defines it."),
  updated_at: z.string().nullable(),
})

export const rulesetSchema = rulesetRowSchema.extend({
  conditions: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("Which refs it applies to, as GitHub gives it (e.g. ref_name with include and exclude); null if none."),
  rules: z
    .array(
      z.object({
        type: z.string(),
        parameters: z.record(z.string(), z.unknown()).nullable().describe("null for a rule that takes none."),
      }),
    )
    .describe("The rules, as GitHub gives them."),
  bypass_actors: z
    .array(
      z.object({
        actor_id: z.number().int().nullable().describe("null for an actor with no id, such as a deploy key."),
        actor_type: z.string(),
        bypass_mode: z.string(),
      }),
    )
    .nullable()
    .describe("Who may bypass it; null when GitHub does not show the viewer."),
  created_at: z.string().nullable(),
  updated_at: z
    .string()
    .nullable()
    .describe("When it last changed; github_ruleset_edit takes it to detect a change made meanwhile."),
  url: z.string().nullable().describe("Its page on GitHub; null if GitHub gives none."),
})

export const classicRuleSchema = z.object({
  pattern: z.string().describe("The branch name pattern the rule protects."),
  required_approvals: z.number().int().describe("Approving reviews required before merging; 0 when none are."),
  required_checks: z.array(z.string()).describe("Status checks that must pass; empty when none are required."),
  allows_force_pushes: z.boolean(),
  allows_deletions: z.boolean(),
  linear_history: z.boolean().describe("Whether merge commits are refused."),
  enforce_admins: z.boolean().describe("Whether administrators are held to the rule too."),
})

export type RulesetRow = z.output<typeof rulesetRowSchema>
export type Ruleset = z.output<typeof rulesetSchema>
export type ClassicRule = z.output<typeof classicRuleSchema>

type RawRuleset = {
  id: number
  name: string
  target: string
  enforcement: string
  source_type: string
  source: string
  conditions?: Record<string, unknown> | null
  rules?: { type: string; parameters?: Record<string, unknown> | null }[] | null
  bypass_actors?: { actor_id?: number | null; actor_type: string; bypass_mode: string }[] | null
  created_at?: string | null
  updated_at?: string | null
  _links?: { html?: { href?: string } | null } | null
}

type RawClassicRule = {
  pattern: string
  requiresApprovingReviews: boolean
  requiredApprovingReviewCount?: number | null
  requiresStatusChecks: boolean
  requiredStatusCheckContexts?: (string | null)[] | null
  allowsForcePushes: boolean
  allowsDeletions: boolean
  requiresLinearHistory: boolean
  isAdminEnforced: boolean
}

const CLASSIC_RULES_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    branchProtectionRules(first:100,after:$after){
      nodes{pattern requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks requiredStatusCheckContexts allowsForcePushes allowsDeletions requiresLinearHistory isAdminEnforced}
      pageInfo{hasNextPage endCursor}
    }
  }
}`

function rulesetsPath(repo: RepoName): string {
  return `repos/${repo.owner}/${repo.name}/rulesets`
}

function toRow(raw: RawRuleset): RulesetRow {
  return {
    id: raw.id,
    name: raw.name,
    target: raw.target,
    enforcement: raw.enforcement,
    source_type: raw.source_type,
    source: raw.source,
    updated_at: raw.updated_at ?? null,
  }
}

/** The repository's rulesets, with those inherited from its organization or enterprise when `includeParents` is set. */
export async function listRulesets(
  repo: RepoName,
  options: { includeParents: boolean },
  ctx: RefContext,
): Promise<RulesetRow[]> {
  // --slurp keeps the pages a valid JSON document: an array of one array per page.
  let pages: RawRuleset[][] | null
  try {
    pages = await ghJson<RawRuleset[][]>(
      ["api", `${rulesetsPath(repo)}?includes_parents=${options.includeParents}&per_page=100`, "--paginate", "--slurp"],
      ctx,
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw repositoryNotFound(repo.full, error)
    throw error
  }
  return (pages ?? []).flat().map(toRow)
}

/** One ruleset in full; one that does not exist is `not_found`. */
export async function readRuleset(repo: RepoName, id: number, ctx: RefContext): Promise<Ruleset> {
  let raw: RawRuleset | null
  try {
    raw = await ghJson<RawRuleset>(["api", `${rulesetsPath(repo)}/${id}`], ctx)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw rulesetNotFound(repo, id, error)
    throw error
  }
  if (!raw) throw rulesetNotFound(repo, id)
  return toRuleset(raw)
}

function toRuleset(raw: RawRuleset): Ruleset {
  return {
    ...toRow(raw),
    conditions: raw.conditions ?? null,
    rules: (raw.rules ?? []).map((rule) => ({ type: rule.type, parameters: rule.parameters ?? null })),
    bypass_actors: raw.bypass_actors
      ? raw.bypass_actors.map((actor) => ({
          actor_id: actor.actor_id ?? null,
          actor_type: actor.actor_type,
          bypass_mode: actor.bypass_mode,
        }))
      : null,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    url: raw._links?.html?.href ?? null,
  }
}

/** Sends `POST` to the repository's rulesets with `body` and returns the ruleset GitHub made. */
export async function createRuleset(repo: RepoName, body: Record<string, unknown>, ctx: RefContext): Promise<Ruleset> {
  const raw = await refusalAsInvalid(() =>
    ghJson<RawRuleset>(["api", "-X", "POST", rulesetsPath(repo), "--input", "-"], {
      ...ctx,
      stdin: JSON.stringify(body),
    }),
  )
  if (!raw) throw new ToolError("upstream_error", "GitHub did not return the ruleset it created.")
  return toRuleset(raw)
}

/** Sends `PUT` to ruleset `id` with `body`, whose fields replace those of the ruleset, and returns the ruleset as it is now. */
export async function updateRuleset(
  repo: RepoName,
  id: number,
  body: Record<string, unknown>,
  ctx: RefContext,
): Promise<Ruleset> {
  let raw: RawRuleset | null
  try {
    raw = await refusalAsInvalid(() =>
      ghJson<RawRuleset>(["api", "-X", "PUT", `${rulesetsPath(repo)}/${id}`, "--input", "-"], {
        ...ctx,
        stdin: JSON.stringify(body),
      }),
    )
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw rulesetNotFound(repo, id, error)
    throw error
  }
  if (!raw) throw new ToolError("upstream_error", `GitHub did not return ruleset ${id} it changed.`)
  return toRuleset(raw)
}

/** Deletes ruleset `id`. */
export async function deleteRuleset(repo: RepoName, id: number, ctx: RefContext): Promise<void> {
  try {
    await refusalAsInvalid(() => gh(["api", "-X", "DELETE", `${rulesetsPath(repo)}/${id}`], ctx))
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") throw rulesetNotFound(repo, id, error)
    throw error
  }
}

function rulesetNotFound(repo: RepoName, id: number, cause?: unknown): ToolError {
  return new ToolError("not_found", `Ruleset ${id} was not found in ${repo.full}, or the viewer cannot see it.`, {
    cause,
  })
}

function toClassicRule(raw: RawClassicRule): ClassicRule {
  return {
    pattern: raw.pattern,
    required_approvals: raw.requiresApprovingReviews ? (raw.requiredApprovingReviewCount ?? 0) : 0,
    required_checks: raw.requiresStatusChecks
      ? (raw.requiredStatusCheckContexts ?? []).filter((context): context is string => context !== null)
      : [],
    allows_force_pushes: raw.allowsForcePushes,
    allows_deletions: raw.allowsDeletions,
    linear_history: raw.requiresLinearHistory,
    enforce_admins: raw.isAdminEnforced,
  }
}

/**
 * The repository's classic branch protection rules, read only. `null` when
 * GitHub refuses the read for lack of permission; any other failure is thrown.
 */
export async function listClassicRules(repo: RepoName, ctx: RefContext): Promise<ClassicRule[] | null> {
  try {
    const { items } = await readRepositoryPages<RawClassicRule>(
      repo,
      CLASSIC_RULES_QUERY,
      (repository) => repository.branchProtectionRules,
      { ...ctx, limit: MAX_CLASSIC_RULES },
    )
    return items.map(toClassicRule)
  } catch (error) {
    if (isToolError(error) && error.code === "forbidden") return null
    throw error
  }
}
