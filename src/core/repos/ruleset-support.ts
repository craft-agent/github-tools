import { z } from "zod"
import { ToolError } from "../errors"
import { listRulesets, type Ruleset, type RulesetRow } from "../github/rulesets"
import { invalid } from "../write-support"
import type { RefContext, RepoName } from "../refs"

/** What the ruleset write tools share: the argument shapes, ref patterns, and the checks made before a ruleset is written. */

export const RULESET_TARGETS = ["branch", "tag", "push"] as const
const ENFORCEMENTS = ["active", "evaluate", "disabled"] as const
const ACTOR_TYPES = ["Integration", "OrganizationAdmin", "RepositoryRole", "Team", "DeployKey"] as const
const BYPASS_MODES = ["always", "pull_request", "exempt"] as const
const DEFAULT_BYPASS_MODE = "always"

const DEFAULT_BRANCH_PATTERN = "~DEFAULT_BRANCH"
const ALL_REFS_PATTERN = "~ALL"
const FULL_REF_PREFIX = "refs/"
const REF_PREFIXES: Readonly<Record<string, string>> = { branch: "refs/heads/", tag: "refs/tags/" }

/** What a ruleset defined by the repository itself reports as its source type. */
const REPOSITORY_SOURCE = "Repository"

export const DEFAULT_INCLUDE: readonly string[] = [DEFAULT_BRANCH_PATTERN]

export const rulesetIdInput = z.number().int().min(1).describe("The ruleset's id, as github_ruleset_read gives it.")
export const rulesetNameInput = z.string().trim().min(1)
export const enforcementInput = z
  .enum(ENFORCEMENTS)
  .describe("active, evaluate (only reported) or disabled (kept, not enforced).")
export const updatedAtInput = z
  .string()
  .optional()
  .describe(
    "The ruleset's updated_at from github_ruleset_read: if it changed since, the call fails with stale and writes nothing.",
  )

/** A list argument of ref patterns; `what` says which refs it holds and what an omitted list means. */
export const patternsInput = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `${what} Patterns: ~DEFAULT_BRANCH, ~ALL and anything starting with refs/ are kept; a bare name or glob gets refs/heads/ (branch) or refs/tags/ (tag) in front.`,
    )

export const rulesInput = z.array(
  z.object({
    type: z.string().trim().min(1).describe("The rule type, such as deletion or pull_request."),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The rule's parameters as GitHub defines them; leave out for a rule that takes none."),
  }),
)

export const bypassInput = z.array(
  z.object({
    actor_type: z.enum(ACTOR_TYPES),
    actor_id: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("The actor's id; null or left out for a deploy key, 1 for OrganizationAdmin."),
    bypass_mode: z.enum(BYPASS_MODES).optional().describe(`${DEFAULT_BYPASS_MODE} (default), pull_request or exempt.`),
  }),
)

type RuleArgument = z.output<typeof rulesInput>[number]
type BypassArgument = z.output<typeof bypassInput>[number]

/** A rule as it is compared with the ruleset's own: `parameters` is `null` for a rule that takes none. */
export type NormalRule = { type: string; parameters: Record<string, unknown> | null }
export type NormalBypass = { actor_id: number | null; actor_type: string; bypass_mode: string }

export function normalRules(rules: readonly RuleArgument[]): NormalRule[] {
  return rules.map((rule) => ({ type: rule.type, parameters: rule.parameters ?? null }))
}

/** The rules as a write sends them. */
export function ruleBodies(rules: readonly NormalRule[]): { type: string; parameters?: Record<string, unknown> }[] {
  return rules.map((rule) => (rule.parameters ? { type: rule.type, parameters: rule.parameters } : { type: rule.type }))
}

/** The bypass actors as a write sends them, which is also the form they are compared in. */
export function normalBypass(bypass: readonly BypassArgument[]): NormalBypass[] {
  return bypass.map((actor) => ({
    actor_id: actor.actor_id ?? null,
    actor_type: actor.actor_type,
    bypass_mode: actor.bypass_mode ?? DEFAULT_BYPASS_MODE,
  }))
}

/** Throws `invalid_argument` when `target` has no refs to include or exclude (a push ruleset). */
export function assertRefTarget(target: string, argument: string): void {
  if (REF_PREFIXES[target] !== undefined) return
  throw invalid(`A ${target} ruleset has no ref conditions, so ${argument} does not apply to it; leave it out.`)
}

/** The patterns for `target`'s refs: the ones GitHub knows kept, a bare name or glob given its `refs/heads/` or `refs/tags/` prefix. */
export function normalisePatterns(target: string, argument: string, patterns: readonly string[]): string[] {
  assertRefTarget(target, argument)
  return patterns.map((raw) => {
    const pattern = raw.trim()
    if (!pattern) throw invalid(`${argument}: a ref pattern cannot be blank.`)
    if (pattern === DEFAULT_BRANCH_PATTERN || pattern === ALL_REFS_PATTERN || pattern.startsWith(FULL_REF_PREFIX)) {
      return pattern
    }
    return `${REF_PREFIXES[target]}${pattern}`
  })
}

function textsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** The ref patterns a ruleset includes and excludes; both are empty when it has no ref conditions. */
export function currentRefs(ruleset: Ruleset): { include: string[]; exclude: string[] } {
  const refName = ruleset.conditions?.ref_name as { include?: unknown; exclude?: unknown } | null | undefined
  return { include: textsOf(refName?.include), exclude: textsOf(refName?.exclude) }
}

/** The refs a ruleset covers, in words, for a confirmation. */
export function describeRefs(target: string, include: readonly string[], exclude: readonly string[]): string {
  if (REF_PREFIXES[target] === undefined) return "every push to the repository"
  const covered = include.join(", ") || "no refs"
  return exclude.length > 0 ? `${covered} except ${exclude.join(", ")}` : covered
}

/** The row of the repository's own ruleset named `name` (without regard to case), other than `exceptId`. */
export async function findOwnRulesetNamed(
  repo: RepoName,
  name: string,
  exceptId: number | undefined,
  ctx: RefContext,
): Promise<RulesetRow | undefined> {
  const rows = await listRulesets(repo, { includeParents: false }, ctx)
  return rows.find(
    (row) =>
      row.source_type === REPOSITORY_SOURCE && row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
  )
}

/** Throws `invalid_argument` for a ruleset the repository inherits, which is changed where it is defined. */
export function assertOwnRuleset(repo: RepoName, ruleset: Ruleset, verb: "edit" | "delete"): void {
  if (ruleset.source_type === REPOSITORY_SOURCE) return
  throw invalid(
    `Ruleset ${ruleset.id} "${ruleset.name}" is inherited by ${repo.full} from ${ruleset.source_type.toLowerCase()} ${ruleset.source}; ${verb} it where it is defined.`,
  )
}

/** The `updated_at` a caller passed, as the instant it names. */
export type ExpectedUpdate = { text: string; instant: number }

/** The instant `updatedAt` names; text that is no timestamp is `invalid_argument`. */
export function expectedUpdate(updatedAt: string | undefined): ExpectedUpdate | undefined {
  if (updatedAt === undefined) return undefined
  const instant = Date.parse(updatedAt)
  if (Number.isNaN(instant)) {
    throw invalid(`updated_at "${updatedAt}" is not a timestamp; pass the updated_at github_ruleset_read gave.`)
  }
  return { text: updatedAt, instant }
}

/** Throws `stale` unless the ruleset was last changed at the instant `expected` names (a ruleset that shows none counts as changed). */
export function assertUnchanged(repo: RepoName, ruleset: Ruleset, expected: ExpectedUpdate | undefined): void {
  if (!expected) return
  const current = ruleset.updated_at === null ? Number.NaN : Date.parse(ruleset.updated_at)
  if (current === expected.instant) return
  throw new ToolError(
    "stale",
    `Ruleset ${ruleset.id} of ${repo.full} was last changed at ${ruleset.updated_at ?? "a time GitHub does not show"}, not ${expected.text}: it changed since it was read. Nothing was written; read it again with github_ruleset_read.`,
  )
}
