import { z } from "zod"
import {
  createRepository,
  findRepository,
  readRepositoryOwner,
  visibilitySchema,
  type Visibility,
} from "../github/repos"
import { given, invalid } from "../write-support"
import { parseRepo } from "../refs"
import { confirmWrite, defineTool } from "../tool"

const DEFAULT_VISIBILITY: Visibility = "private"

const input = z.object({
  repo: z
    .string()
    .describe(
      "The repository to create, as owner/name. The owner is the viewer or an organization the viewer can create repositories in.",
    ),
  visibility: visibilitySchema
    .optional()
    .describe(
      `public, private or internal (default ${DEFAULT_VISIBILITY}). internal only for an organization's repository.`,
    ),
  description: z.string().optional().describe("A short description."),
  homepage: z.string().optional().describe("A homepage link. Not with template."),
  template: z
    .string()
    .optional()
    .describe("A template repository to create it from, as owner/name. Not with license, gitignore or add_readme."),
  license: z.string().optional().describe("A license template key, such as mit or apache-2.0."),
  gitignore: z.string().optional().describe("A .gitignore template name, such as Node."),
  add_readme: z.boolean().optional().describe("Start the repository with a README."),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  url: z.string(),
  visibility: visibilitySchema,
  created: z.literal(true),
})

function confirmation(repo: string, visibility: Visibility, template: string | undefined): string {
  const from = template === undefined ? "" : ` from the template ${template}`
  const exposure = visibility === "public" ? " A public repository is readable by anyone." : ""
  return `Create the ${visibility} repository ${repo}${from}?${exposure}`
}

export const repoCreate = defineTool({
  id: "github_repo_create",
  title: "Create a GitHub repository",
  intent: "About to create a GitHub repository",
  description: [
    "Create a repository for the viewer or for an organization the viewer can create repositories in (repo, owner/name), private unless visibility says public or internal; a public one is readable by anyone.",
    "internal is for an organization's repository only.",
    "template creates it from a template repository (its files, not its other branches); then license, gitignore, add_readme, homepage and internal are refused, since the template decides the content. Without a template, license (a key such as mit), gitignore (a name such as Node) and add_readme start the repository with those files.",
    "Refuses a repository that exists already, an owner that is another user, and a template that does not exist or is not a template, before writing.",
  ].join(" "),
  toolset: "repos",
  class: "administrative",
  targets: { repo: "repo" },
  input,
  output,
  async execute(args, ctx) {
    const target = parseRepo(args.repo)
    const visibility = args.visibility ?? DEFAULT_VISIBILITY
    const description = given(args.description)
    const homepage = given(args.homepage)
    const license = given(args.license)
    const gitignore = given(args.gitignore)
    const template = args.template === undefined ? undefined : parseRepo(args.template)
    if (template) {
      if (license || gitignore || args.add_readme) {
        throw invalid(
          "A repository created from a template takes its files from it; leave out license, gitignore and add_readme.",
        )
      }
      if (homepage)
        throw invalid(
          "A repository created from a template cannot be given a homepage; set it with github_repo_edit afterwards.",
        )
      if (visibility === "internal") {
        throw invalid(
          "A repository created from a template is public or private; create it private, then change it with github_repo_visibility.",
        )
      }
    }

    const owner = await readRepositoryOwner(target.owner, ctx)
    if (owner.kind === "user") {
      throw invalid(
        `${target.owner} is another user's account; create the repository as yourself or in an organization.`,
      )
    }
    if (visibility === "internal" && owner.kind !== "organization") {
      throw invalid("internal is for an organization's repository; pick public or private.")
    }
    if (await findRepository(target, ctx)) throw invalid(`Repository ${target.full} exists already.`)
    if (template) {
      const found = await findRepository(template, ctx)
      if (!found) throw invalid(`Template ${template.full} was not found, or the viewer cannot see it.`)
      if (!found.is_template) throw invalid(`${template.full} is not a template repository.`)
    }

    await confirmWrite(repoCreate, ctx, confirmation(target.full, visibility, template?.full))

    const created = template
      ? await createRepository(
          `repos/${template.full}/generate`,
          {
            owner: owner.login,
            name: target.name,
            description,
            private: visibility !== "public",
            include_all_branches: false,
          },
          ctx,
        )
      : await createRepository(
          owner.kind === "organization" ? `orgs/${owner.login}/repos` : "user/repos",
          {
            name: target.name,
            description,
            homepage,
            private: visibility !== "public",
            ...(owner.kind === "organization" ? { visibility } : {}),
            auto_init: args.add_readme,
            license_template: license,
            gitignore_template: gitignore,
          },
          ctx,
        )
    return {
      repo: created.repo,
      url: created.url,
      visibility: created.visibility ?? visibility,
      created: true as const,
    }
  },
})
