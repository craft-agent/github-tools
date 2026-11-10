import { z } from "zod"
import { branchHead } from "../github/branches"
import { patchRepository, readAdministeredRepository, replaceTopics, type Repository } from "../github/repos"
import { repositoryContext } from "../github/repository"
import { REPO_DESCRIPTION, invalid } from "../write-support"
import { resolveRepo } from "../refs"
import { defineTool, type CallDescription, type CallFact, type ToolContext } from "../tool"
import { NOTHING_CHANGED, changeFact } from "../write-facts"
import { describedRepo, repoHeadline } from "./describe-support"

const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/
const MERGE_METHOD_SETTINGS = ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"] as const
const SETTING_NAMES = [
  "description",
  "homepage",
  "default_branch",
  "has_issues",
  "has_wiki",
  "has_projects",
  "has_discussions",
  ...MERGE_METHOD_SETTINGS,
  "allow_auto_merge",
  "delete_branch_on_merge",
  "allow_update_branch",
  "is_template",
] as const
const CHANGES = [...SETTING_NAMES, "topics"] as const

type Setting = (typeof SETTING_NAMES)[number]

/** Where the repository view holds each setting, which GitHub's REST API names differently than `github_repo_read` does. */
const CURRENT: Record<Setting, (repository: Repository) => string | boolean | null> = {
  description: (repository) => repository.description,
  homepage: (repository) => repository.homepage,
  default_branch: (repository) => repository.default_branch,
  has_issues: (repository) => repository.features.issues,
  has_wiki: (repository) => repository.features.wiki,
  has_projects: (repository) => repository.features.projects,
  has_discussions: (repository) => repository.features.discussions,
  allow_merge_commit: (repository) => repository.merge.merge_commit,
  allow_squash_merge: (repository) => repository.merge.squash,
  allow_rebase_merge: (repository) => repository.merge.rebase,
  allow_auto_merge: (repository) => repository.merge.auto_merge,
  delete_branch_on_merge: (repository) => repository.merge.delete_branch_on_merge,
  allow_update_branch: (repository) => repository.merge.update_branch,
  is_template: (repository) => repository.is_template,
}

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  description: z.string().optional().describe("The repository's description; empty clears it."),
  homepage: z.string().optional().describe("The homepage link; empty clears it."),
  default_branch: z.string().min(1).optional().describe("The branch to make the default; it must exist."),
  add_topics: z.array(z.string()).optional().describe("Topics to add, lowercased: letters, digits and hyphens."),
  remove_topics: z.array(z.string()).optional().describe("Topics to remove."),
  has_issues: z.boolean().optional().describe("Whether issues are on (github_repo_read: features.issues)."),
  has_wiki: z.boolean().optional().describe("Whether the wiki is on (features.wiki)."),
  has_projects: z.boolean().optional().describe("Whether projects are on (features.projects)."),
  has_discussions: z.boolean().optional().describe("Whether discussions are on (features.discussions)."),
  allow_merge_commit: z.boolean().optional().describe("Allow merge commits (merge.merge_commit)."),
  allow_squash_merge: z.boolean().optional().describe("Allow squash merging (merge.squash)."),
  allow_rebase_merge: z.boolean().optional().describe("Allow rebase merging (merge.rebase)."),
  allow_auto_merge: z.boolean().optional().describe("Allow auto-merge on pull requests (merge.auto_merge)."),
  delete_branch_on_merge: z
    .boolean()
    .optional()
    .describe("Delete a merged pull request's branch (merge.delete_branch_on_merge)."),
  allow_update_branch: z
    .boolean()
    .optional()
    .describe("Offer to update a pull request's branch from its base (merge.update_branch)."),
  is_template: z.boolean().optional().describe("Whether the repository is a template."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  changed: z.array(z.enum(CHANGES)).describe("The arguments that changed something; [] when nothing was sent."),
  foreign: z.boolean(),
})

/** The distinct topics of a list argument, trimmed and lowercased; one GitHub would refuse is refused here. */
function topicList(argument: string, values: string[] | undefined): string[] {
  const topics = [...new Set((values ?? []).map((value) => value.trim().toLowerCase()))]
  const bad = topics.find((topic) => !TOPIC_PATTERN.test(topic))
  if (bad !== undefined) {
    throw invalid(
      `${argument}: "${bad}" is not a topic; use lowercase letters, digits and hyphens, starting with a letter or digit, at most 50 characters.`,
    )
  }
  return topics
}

/** The names the `Features`, `Merge methods` and `Merge options` facts list, by the setting that turns each on or off. */
const FEATURE_NAMES: Partial<Record<Setting, string>> = {
  has_issues: "issues",
  has_wiki: "wiki",
  has_projects: "projects",
  has_discussions: "discussions",
}
const METHOD_NAMES: Partial<Record<Setting, string>> = {
  allow_merge_commit: "merge_commit",
  allow_squash_merge: "squash",
  allow_rebase_merge: "rebase",
}
const OPTION_NAMES: Partial<Record<Setting, string>> = {
  allow_auto_merge: "auto_merge",
  delete_branch_on_merge: "delete_branch_on_merge",
  allow_update_branch: "update_branch",
}

/** Describes the call: what differs from the repository's settings, as `execute` weighs it, and nothing sent when nothing does. */
async function describeEdit(args: z.output<typeof input>, ctx: ToolContext): Promise<CallDescription> {
  const add = topicList("add_topics", args.add_topics)
  const remove = topicList("remove_topics", args.remove_topics)
  const both = add.find((topic) => remove.includes(topic))
  if (both !== undefined) throw invalid(`The topic "${both}" is in both add_topics and remove_topics.`)
  if (
    args.add_topics === undefined &&
    args.remove_topics === undefined &&
    SETTING_NAMES.every((name) => args[name] === undefined)
  ) {
    throw invalid("Pass at least one setting to change, or topics to add or remove.")
  }

  const { view, target } = await describedRepo(args, ctx)
  if (view.archived) {
    throw invalid(
      `${view.repo} is archived, so its settings cannot change; unarchive it with github_repo_unarchive first.`,
    )
  }
  const effective = (name: Setting) => args[name] ?? CURRENT[name](view)
  if (MERGE_METHOD_SETTINGS.some((name) => args[name] !== undefined) && !MERGE_METHOD_SETTINGS.some(effective)) {
    throw invalid(
      `That would turn off every merge method of ${view.repo}; keep at least one of ${MERGE_METHOD_SETTINGS.join(", ")} on.`,
    )
  }
  if (
    args.default_branch !== undefined &&
    args.default_branch !== view.default_branch &&
    (await branchHead(target, args.default_branch, ctx)) === null
  ) {
    throw invalid(`${view.repo} has no branch "${args.default_branch}" to make the default; push it first.`)
  }

  const changed = SETTING_NAMES.filter((name) => args[name] !== undefined && args[name] !== CURRENT[name](view))
  const added = add.filter((topic) => !view.topics.includes(topic))
  const removed = remove.filter((topic) => view.topics.includes(topic))
  const headline = repoHeadline("About to edit the settings of the repository {name}", view.repo)
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    return { ...headline, facts: [{ label: "State", value: { text: NOTHING_CHANGED } }] }
  }

  const toggles = (label: string, names: Partial<Record<Setting, string>>) =>
    changeFact(
      label,
      changed.flatMap((name) => (names[name] !== undefined && args[name] === true ? [names[name]] : [])),
      changed.flatMap((name) => (names[name] !== undefined && args[name] === false ? [names[name]] : [])),
    )
  const description = changed.includes("description") ? args.description : undefined
  const facts = [
    changed.includes("default_branch") ? { label: "Default branch", value: args.default_branch! } : undefined,
    changeFact("Topics", added, removed),
    toggles("Features", FEATURE_NAMES),
    toggles("Merge methods", METHOD_NAMES),
    toggles("Merge options", OPTION_NAMES),
    changed.includes("is_template")
      ? { label: "Template repository", value: { text: args.is_template ? "On" : "Off" } }
      : undefined,
    changed.includes("homepage")
      ? { label: "Homepage", value: args.homepage === "" ? { text: "Cleared" } : args.homepage! }
      : undefined,
    description === "" ? { label: "Description", value: { text: "Cleared" } } : undefined,
  ].filter((fact): fact is CallFact => fact !== undefined)
  return {
    ...headline,
    facts,
    ...(description ? { text: { label: "Description", body: description } } : {}),
  }
}

export const repoEdit = defineTool({
  id: "github_repo_edit",
  title: "Edit a GitHub repository's settings",
  intent: "About to edit a GitHub repository's settings",
  description: [
    "Edit a repository's settings: description, homepage, default branch, topics (add_topics, remove_topics), the features that are on and the merge methods and options. Pass at least one.",
    "The boolean arguments are GitHub's REST names; github_repo_read view reports them under features (has_issues as issues, has_wiki as wiki, has_projects as projects, has_discussions as discussions) and merge (allow_merge_commit as merge_commit, allow_squash_merge as squash, allow_rebase_merge as rebase, allow_auto_merge as auto_merge, delete_branch_on_merge, allow_update_branch as update_branch); is_template keeps its name.",
    "Needs admin permission on the repository. Refuses an archived repository (github_repo_unarchive first), a topic that is not lowercase letters, digits and hyphens, a topic in both lists, a default branch that does not exist, and a change that leaves all three merge methods off, before writing.",
    "Only what differs from the current settings is sent; changed lists those arguments (topics for add_topics and remove_topics) and is [] when nothing is written.",
  ].join(" "),
  toolset: "repos",
  class: "overwrite",
  targets: { repo: "repo" },
  describe: describeEdit,
  input,
  output,
  async execute(args, ctx) {
    const add = topicList("add_topics", args.add_topics)
    const remove = topicList("remove_topics", args.remove_topics)
    const both = add.find((topic) => remove.includes(topic))
    if (both !== undefined) throw invalid(`The topic "${both}" is in both add_topics and remove_topics.`)
    if (
      args.add_topics === undefined &&
      args.remove_topics === undefined &&
      SETTING_NAMES.every((name) => args[name] === undefined)
    ) {
      throw invalid("Pass at least one setting to change, or topics to add or remove.")
    }

    const { view, target } = await readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
    if (view.archived) {
      throw invalid(
        `${view.repo} is archived, so its settings cannot change; unarchive it with github_repo_unarchive first.`,
      )
    }
    const effective = (name: Setting) => args[name] ?? CURRENT[name](view)
    if (MERGE_METHOD_SETTINGS.some((name) => args[name] !== undefined) && !MERGE_METHOD_SETTINGS.some(effective)) {
      throw invalid(
        `That would turn off every merge method of ${view.repo}; keep at least one of ${MERGE_METHOD_SETTINGS.join(", ")} on.`,
      )
    }
    if (
      args.default_branch !== undefined &&
      args.default_branch !== view.default_branch &&
      (await branchHead(target, args.default_branch, ctx)) === null
    ) {
      throw invalid(`${view.repo} has no branch "${args.default_branch}" to make the default; push it first.`)
    }

    const changedSettings = SETTING_NAMES.filter(
      (name) => args[name] !== undefined && args[name] !== CURRENT[name](view),
    )
    const topics = [
      ...view.topics.filter((topic) => !remove.includes(topic)),
      ...add.filter((topic) => !view.topics.includes(topic)),
    ]
    const topicsChanged = topics.length !== view.topics.length || topics.some((topic) => !view.topics.includes(topic))
    const foreign = (await repositoryContext(target, ctx)).foreign

    if (changedSettings.length > 0) {
      await patchRepository(target, Object.fromEntries(changedSettings.map((name) => [name, args[name]])), ctx)
    }
    if (topicsChanged) await replaceTopics(target, topics, ctx)
    return { repo: view.repo, changed: [...changedSettings, ...(topicsChanged ? ["topics" as const] : [])], foreign }
  },
})
