import { z } from "zod"
import { readAdministeredRepository } from "../github/repos"
import { repositoryContext } from "../github/repository"
import { deleteRuleset, readRuleset } from "../github/rulesets"
import { resolveRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"
import { describedRepo } from "./describe-support"
import {
  assertOwnRuleset,
  assertUnchanged,
  enforcementFact,
  expectedUpdate,
  ruleTypes,
  rulesetHeadline,
  rulesetIdInput,
  targetFact,
  updatedAtInput,
} from "./ruleset-support"
import { REPO_DESCRIPTION } from "./support"

export const rulesetDelete = defineTool({
  id: "github_ruleset_delete",
  title: "Delete a GitHub ruleset",
  intent: "About to delete a GitHub ruleset",
  description: [
    'Delete a repository ruleset for good; github_ruleset_edit with enforcement "disabled" keeps it without enforcing it.',
    "Pass updated_at from github_ruleset_read to guard against a change made meanwhile: if the ruleset changed since, the call fails with stale and deletes nothing.",
    "Needs admin permission. Refuses an unknown ruleset and one inherited from the organization (delete it where it is defined), before writing.",
  ].join(" "),
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  async describe(args, ctx) {
    const expected = expectedUpdate(args.updated_at)
    const { target } = await describedRepo(args, ctx)
    const ruleset = await readRuleset(target, args.ruleset, ctx)
    assertOwnRuleset(target, ruleset, "delete")
    assertUnchanged(target, ruleset, expected)
    return {
      ...rulesetHeadline("About to delete the ruleset {name}", ruleset.name),
      facts: [
        enforcementFact(ruleset.enforcement),
        targetFact(ruleset.target),
        ...(ruleset.rules.length > 0 ? [{ label: "Rules", value: ruleTypes(ruleset.rules).join(", ") }] : []),
      ],
      pins: { updated_at: ruleset.updated_at ?? "" },
    }
  },
  input: z.object({
    repo: z.string().optional().describe(REPO_DESCRIPTION),
    ruleset: rulesetIdInput,
    updated_at: updatedAtInput,
  }),
  output: z.object({
    repo: z.string().describe("The repository, as owner/name."),
    deleted: z.object({ id: z.number().int(), name: z.string() }),
    foreign: z.boolean(),
  }),
  async execute(args, ctx) {
    const expected = expectedUpdate(args.updated_at)
    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    const ruleset = await readRuleset(target, args.ruleset, ctx)
    assertOwnRuleset(target, ruleset, "delete")
    assertUnchanged(target, ruleset, expected)
    const foreign = (await repositoryContext(target, ctx)).foreign
    await confirmWrite(
      rulesetDelete,
      ctx,
      `Delete the ruleset "${ruleset.name}" (id ${ruleset.id}) from ${view.repo}? This cannot be undone; to keep it without enforcing it, set its enforcement to "disabled" with github_ruleset_edit instead.`,
    )
    await deleteRuleset(target, ruleset.id, ctx)
    return { repo: view.repo, deleted: { id: ruleset.id, name: ruleset.name }, foreign }
  },
})
