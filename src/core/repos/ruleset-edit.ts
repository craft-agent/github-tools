import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { readAdministeredRepository } from "../github/repos"
import { repositoryContext } from "../github/repository"
import { readRuleset, rulesetSchema, updateRuleset } from "../github/rulesets"
import { invalid } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"
import {
  assertOwnRuleset,
  assertUnchanged,
  bypassInput,
  currentRefs,
  enforcementInput,
  expectedUpdate,
  findOwnRulesetNamed,
  normalBypass,
  normalRules,
  normalisePatterns,
  patternsInput,
  ruleBodies,
  rulesInput,
  rulesetIdInput,
  rulesetNameInput,
  updatedAtInput,
} from "./ruleset-support"
import { REPO_DESCRIPTION } from "./support"

const CHANGES = ["name", "enforcement", "include", "exclude", "rules", "bypass"] as const

type Change = (typeof CHANGES)[number]

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  ruleset: rulesetIdInput,
  updated_at: updatedAtInput,
  name: rulesetNameInput
    .optional()
    .describe("The ruleset's new name; the repository's other rulesets must not have it."),
  enforcement: enforcementInput.optional(),
  include: patternsInput("Replaces the refs it covers; exclude keeps its value. Not for a push ruleset."),
  exclude: patternsInput("Replaces the refs it leaves out; include keeps its value. Not for a push ruleset."),
  rules: rulesInput
    .optional()
    .describe("Replaces the whole list of rules: { type, parameters? }. GitHub validates them."),
  bypass: bypassInput.optional().describe("Replaces the whole list of who may bypass it; [] leaves nobody."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  ruleset: rulesetSchema.describe("The ruleset as it is now."),
  changed: z.array(z.enum(CHANGES)).describe("The parts that changed; [] when nothing was sent."),
  foreign: z.boolean(),
})

const list = (values: readonly string[], none: string): string => values.join(", ") || none

export const rulesetEdit = defineTool({
  id: "github_ruleset_edit",
  title: "Edit a GitHub ruleset",
  description: [
    "Edit a repository's ruleset: name, enforcement, the refs it covers (include and exclude, each replacing its list), rules and bypass (each replacing the whole list). Pass at least one part.",
    'Ref patterns are read as github_ruleset_create reads them. enforcement "disabled" keeps a ruleset without enforcing it. GitHub validates the rule types and parameters and refuses bad ones as invalid_argument.',
    "Pass updated_at from github_ruleset_read to guard against a change made meanwhile: if the ruleset changed since, the call fails with stale and writes nothing.",
    "Needs admin permission. Refuses an unknown ruleset, one inherited from the organization (edit it where it is defined), and a name another ruleset of the repository has, before writing. Only the parts that differ are sent; changed lists them and is [] when nothing is written.",
  ].join(" "),
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    if (CHANGES.every((part) => args[part] === undefined)) {
      throw invalid(`Pass at least one of ${CHANGES.join(", ")} to change the ruleset.`)
    }
    const expected = expectedUpdate(args.updated_at)

    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    const ruleset = await readRuleset(target, args.ruleset, ctx)
    assertOwnRuleset(target, ruleset, "edit")
    assertUnchanged(target, ruleset, expected)
    if (args.name !== undefined && args.name !== ruleset.name) {
      const taken = await findOwnRulesetNamed(target, args.name, ruleset.id, ctx)
      if (taken) {
        throw invalid(
          `${view.repo} has another ruleset named "${taken.name}" already (id ${taken.id}); pick another name.`,
        )
      }
    }

    const refs = currentRefs(ruleset)
    const include = args.include && normalisePatterns(ruleset.target, "include", args.include)
    const exclude = args.exclude && normalisePatterns(ruleset.target, "exclude", args.exclude)
    const rules = args.rules && normalRules(args.rules)
    const bypass = args.bypass && normalBypass(args.bypass)
    const parts: { part: Change; next: unknown; now: unknown; summary: string }[] = [
      { part: "name", next: args.name, now: ruleset.name, summary: `name to "${args.name}"` },
      {
        part: "enforcement",
        next: args.enforcement,
        now: ruleset.enforcement,
        summary: `enforcement from ${ruleset.enforcement} to ${args.enforcement}`,
      },
      { part: "include", next: include, now: refs.include, summary: `include to ${list(include ?? [], "no refs")}` },
      { part: "exclude", next: exclude, now: refs.exclude, summary: `exclude to ${list(exclude ?? [], "no refs")}` },
      {
        part: "rules",
        next: rules,
        now: ruleset.rules,
        summary: `rules to ${list(rules?.map((rule) => rule.type) ?? [], "none")}`,
      },
      { part: "bypass", next: bypass, now: ruleset.bypass_actors, summary: `bypass actors to ${bypass?.length ?? 0}` },
    ]
    const differing = parts.filter(({ next, now }) => next !== undefined && !isDeepStrictEqual(next, now))
    const changed = differing.map(({ part }) => part)
    const foreign = (await repositoryContext(target, ctx)).foreign
    if (changed.length === 0) return { repo: view.repo, ruleset, changed, foreign }

    const has = (part: Change) => changed.includes(part)
    await confirmWrite(
      rulesetEdit,
      ctx,
      `Change the ruleset "${ruleset.name}" (id ${ruleset.id}) of ${view.repo}? It changes: ${differing.map(({ summary }) => summary).join("; ")}.`,
    )
    const updated = await updateRuleset(
      target,
      ruleset.id,
      {
        ...(has("name") && { name: args.name }),
        ...(has("enforcement") && { enforcement: args.enforcement }),
        ...((has("include") || has("exclude")) && {
          conditions: {
            ...ruleset.conditions,
            ref_name: { include: include ?? refs.include, exclude: exclude ?? refs.exclude },
          },
        }),
        ...(has("rules") && rules && { rules: ruleBodies(rules) }),
        ...(has("bypass") && { bypass_actors: bypass }),
      },
      ctx,
    )
    return { repo: view.repo, ruleset: updated, changed, foreign }
  },
})
