import { z } from "zod"
import { tagCommit } from "../github/branches"
import {
  PRERELEASE_CANNOT_BE_LATEST,
  findRelease,
  latestReleaseId,
  releaseNotFound,
  releaseTagInput,
  resolveTarget,
  updateRelease,
  type ReleaseBody,
} from "../github/releases"
import { REPO_DESCRIPTION, invalid, writableContext } from "../write-support"
import { resolveRepo } from "../refs"
import { githubTargets } from "../github/targets"
import { defineTool, type CallFact } from "../tool"
import { NOTHING_CHANGED, digest } from "../write-facts"
import { describedRelease, releaseHeadline, switchValue } from "./describe-support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  tag: releaseTagInput,
  title: z.string().optional().describe("The release's title."),
  notes: z.string().optional().describe("The release notes, in Markdown; replaces them; empty clears them."),
  prerelease: z.boolean().optional().describe("Whether to mark the release as a pre-release."),
  latest: z
    .boolean()
    .optional()
    .describe("Mark the published release as the repository's latest (true) or not (false)."),
  target: z
    .string()
    .optional()
    .describe("The branch or full commit SHA a new tag is made from; drafts only, when the tag does not exist yet."),
})

const CHANGES = ["title", "notes", "prerelease", "latest", "target"] as const

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  tag: z.string().describe("The git tag name of the release."),
  changed: z.array(z.enum(CHANGES)).describe("The fields that were changed; empty when nothing was sent."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
})

export const releaseEdit = defineTool({
  id: "github_release_edit",
  title: "Edit a GitHub release",
  intent: "About to edit a GitHub release",
  description:
    "Edit a GitHub release. Replaces only the parts given, on a draft or a published release. Editing notifies no one; publishing is github_release_publish.",
  toolset: "releases",
  class: "overwrite",
  targets: githubTargets({ repo: "repo" }),
  async describe(args, ctx) {
    if (CHANGES.every((field) => args[field] === undefined)) {
      throw invalid("Pass at least one of title, notes, prerelease, latest or target to change the release.")
    }
    if (args.prerelease === true && args.latest === true) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }

    const { repo, current } = await describedRelease(args, ctx)
    if (args.latest !== undefined && current.draft) {
      throw invalid(
        `Release ${args.tag} of ${repo.full} is a draft; mark it latest when publishing it with github_release_publish.`,
      )
    }
    if (args.latest === true && (args.prerelease ?? current.prerelease)) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }
    if (args.target !== undefined) {
      if (!current.draft) {
        throw invalid(
          `Release ${args.tag} of ${repo.full} is a published release; its tag already names a commit; target is only for a draft whose tag does not exist yet.`,
        )
      }
      const tagSha = await tagCommit(repo, args.tag, ctx)
      if (tagSha !== null) {
        throw invalid(
          `Release ${args.tag} of ${repo.full} is a draft, but its tag already names a commit; target is only for a draft whose tag does not exist yet.`,
        )
      }
      await resolveTarget(repo, args.target, ctx)
    }

    const titled = args.title !== undefined && args.title !== (current.name ?? "")
    const noted = args.notes !== undefined && args.notes !== (current.body ?? "")
    const marked = args.prerelease !== undefined && args.prerelease !== current.prerelease
    let latest = false
    if (args.latest !== undefined) {
      const latestId = await latestReleaseId(repo, ctx)
      latest = args.latest !== (latestId !== null && current.id === latestId)
    }
    const retargeted = args.target !== undefined && args.target !== current.target_commitish

    const headline = releaseHeadline("About to edit the release {name}", current)
    if (!titled && !noted && !marked && !latest && !retargeted) {
      return { ...headline, facts: [{ label: "State", value: { text: NOTHING_CHANGED } }] }
    }
    const facts: (CallFact | undefined)[] = [
      titled ? { label: "Title", value: args.title === "" ? { text: "Cleared" } : args.title! } : undefined,
      marked ? { label: "Prerelease", value: switchValue(args.prerelease!) } : undefined,
      latest ? { label: "Latest", value: switchValue(args.latest!) } : undefined,
      retargeted ? { label: "Tag target", value: args.target! } : undefined,
      noted && args.notes === "" ? { label: "Release notes", value: { text: "Cleared" } } : undefined,
    ]
    return {
      ...headline,
      facts: facts.filter((fact): fact is CallFact => fact !== undefined),
      ...(noted && args.notes ? { text: { label: "Release notes", body: args.notes } } : {}),
      ...(noted ? { pins: { notes: digest(current.body ?? "") } } : {}),
    }
  },
  input,
  output,
  async execute(args, ctx) {
    if (CHANGES.every((field) => args[field] === undefined)) {
      throw invalid("Pass at least one of title, notes, prerelease, latest or target to change the release.")
    }
    if (args.prerelease === true && args.latest === true) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const current = await findRelease(repo, args.tag, ctx)
    if (!current) {
      throw releaseNotFound(repo, args.tag)
    }

    if (args.latest !== undefined && current.draft) {
      throw invalid(
        `Release ${args.tag} of ${repo.full} is a draft; mark it latest when publishing it with github_release_publish.`,
      )
    }
    if (args.latest === true && (args.prerelease ?? current.prerelease)) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }

    if (args.target !== undefined) {
      if (!current.draft) {
        throw invalid(
          `Release ${args.tag} of ${repo.full} is a published release; its tag already names a commit; target is only for a draft whose tag does not exist yet.`,
        )
      }
      const tagSha = await tagCommit(repo, args.tag, ctx)
      if (tagSha !== null) {
        throw invalid(
          `Release ${args.tag} of ${repo.full} is a draft, but its tag already names a commit; target is only for a draft whose tag does not exist yet.`,
        )
      }
      await resolveTarget(repo, args.target, ctx)
    }

    const changed: (typeof CHANGES)[number][] = []
    const body: ReleaseBody = {}

    if (args.title !== undefined && args.title !== (current.name ?? "")) {
      changed.push("title")
      body.name = args.title
    }
    if (args.notes !== undefined && args.notes !== (current.body ?? "")) {
      changed.push("notes")
      body.body = args.notes
    }
    if (args.prerelease !== undefined && args.prerelease !== current.prerelease) {
      changed.push("prerelease")
      body.prerelease = args.prerelease
    }
    if (args.latest !== undefined) {
      const latestId = await latestReleaseId(repo, ctx)
      const isLatest = latestId !== null && current.id === latestId
      if (args.latest !== isLatest) {
        changed.push("latest")
        body.make_latest = args.latest ? "true" : "false"
      }
    }
    if (args.target !== undefined && args.target !== current.target_commitish) {
      changed.push("target")
      body.target_commitish = args.target
    }

    if (changed.length > 0) {
      await updateRelease(repo, current, body, ctx)
    }

    return {
      repo: repo.full,
      tag: current.tag_name,
      changed,
      foreign: context.foreign,
    }
  },
})
