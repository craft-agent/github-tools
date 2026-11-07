import { z } from "zod"
import { readAdministeredRepository } from "../github/repos"
import { repositoryContext } from "../github/repository"
import { createRuleset, rulesetSchema } from "../github/rulesets"
import { invalid } from "../write-support"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"
import {
  DEFAULT_INCLUDE,
  RULESET_TARGETS,
  assertRefTarget,
  bypassInput,
  describeRefs,
  enforcementInput,
  findOwnRulesetNamed,
  normalBypass,
  normalRules,
  normalisePatterns,
  patternsInput,
  ruleBodies,
  rulesInput,
  rulesetNameInput,
} from "./ruleset-support"
import { REPO_DESCRIPTION } from "./support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  name: rulesetNameInput.describe("The ruleset's name; the repository's other rulesets must not have it."),
  target: z.enum(RULESET_TARGETS).optional().describe("What it applies to: branch (default), tag or push."),
  enforcement: enforcementInput
    .optional()
    .describe("active (default), evaluate (only reported) or disabled (kept, not enforced)."),
  include: patternsInput(
    'The refs it covers; default ["~DEFAULT_BRANCH"] for a branch ruleset, required for a tag ruleset, not for a push ruleset.',
  ),
  exclude: patternsInput("Refs it leaves out; default none. Not for a push ruleset."),
  rules: rulesInput
    .min(1)
    .describe("The rules, at least one: { type, parameters? }. GitHub validates the types and parameters."),
  bypass: bypassInput.optional().describe("Who may bypass it; default nobody."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  ruleset: rulesetSchema.describe("The ruleset that was created."),
  foreign: z.boolean(),
})

export const rulesetCreate = defineTool({
  id: "github_ruleset_create",
  title: "Create a GitHub ruleset",
  description: [
    "Create a ruleset on a repository: a name, what it applies to (target branch, tag or push), its enforcement, the refs it covers (include, exclude) and its rules.",
    "Ref patterns ~DEFAULT_BRANCH, ~ALL and anything starting with refs/ are kept; a bare name or glob gets refs/heads/ (branch) or refs/tags/ (tag) in front. include defaults to the default branch for a branch ruleset and is required for a tag ruleset; a push ruleset has neither include nor exclude.",
    'enforcement "disabled" keeps a ruleset without enforcing it; "evaluate" only reports what it would block.',
    "GitHub validates the rule types and their parameters and refuses bad ones as invalid_argument.",
    "Needs admin permission; refuses a name another ruleset of the repository has (case-insensitive; change that one with github_ruleset_edit), before writing.",
  ].join(" "),
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const target = args.target ?? "branch"
    const enforcement = args.enforcement ?? "active"
    let conditions: { ref_name: { include: string[]; exclude: string[] } } | undefined
    if (target === "push") {
      if (args.include !== undefined) assertRefTarget(target, "include")
      if (args.exclude !== undefined) assertRefTarget(target, "exclude")
    } else {
      const given = args.include?.length ? args.include : undefined
      if (given === undefined && target === "tag") {
        throw invalid('include is required for a tag ruleset: name the tags it covers, such as ["v*"].')
      }
      conditions = {
        ref_name: {
          include: normalisePatterns(target, "include", given ?? DEFAULT_INCLUDE),
          exclude: normalisePatterns(target, "exclude", args.exclude ?? []),
        },
      }
    }
    const rules = normalRules(args.rules)

    const { view, target: repo } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    const taken = await findOwnRulesetNamed(repo, args.name, undefined, ctx)
    if (taken) {
      throw invalid(
        `${view.repo} has a ruleset named "${taken.name}" already (id ${taken.id}); change it with github_ruleset_edit, or pick another name.`,
      )
    }
    const foreign = (await repositoryContext(repo, ctx)).foreign

    const refs = describeRefs(target, conditions?.ref_name.include ?? [], conditions?.ref_name.exclude ?? [])
    await confirmWrite(
      rulesetCreate,
      ctx,
      `Create the ruleset "${args.name}" on ${view.repo} with enforcement ${enforcement}? It covers ${refs} and has the rules: ${rules.map((rule) => rule.type).join(", ")}.`,
    )
    const ruleset = await createRuleset(
      repo,
      {
        name: args.name,
        target,
        enforcement,
        ...(conditions && { conditions }),
        rules: ruleBodies(rules),
        bypass_actors: normalBypass(args.bypass ?? []),
      },
      ctx,
    )
    return { repo: view.repo, ruleset, foreign }
  },
})
