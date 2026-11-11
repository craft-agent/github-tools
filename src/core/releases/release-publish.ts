import { z } from "zod"
import { ToolError } from "../errors"
import {
  PRERELEASE_CANNOT_BE_LATEST,
  findRelease,
  latestReleaseId,
  publishCommit,
  releaseNotFound,
  releaseTagInput,
  updateRelease,
  type ReleaseBody,
} from "../github/releases"
import { REPO_DESCRIPTION, given, invalid, writableContext } from "../write-support"
import { resolveRepo, SHA_PATTERN, shortSha } from "../refs"
import { githubTargets } from "../github/targets"
import { confirmWrite, defineTool, type CallFact } from "../tool"
import { describedRelease, releaseHeadline, switchValue } from "./describe-support"

const input = z.object({
  repo: z.string().optional().describe(REPO_DESCRIPTION),
  tag: releaseTagInput,
  latest: z
    .boolean()
    .optional()
    .describe(
      "Mark it the repository's latest release (true) or not (false); default GitHub's choice, which makes a release that is no prerelease the latest.",
    ),
  head_sha: z
    .string()
    .optional()
    .describe(
      "Optional 40-character commit SHA the release was reviewed at. Fails with stale, publishing nothing, if the tag would name another commit.",
    ),
})

const output = z.object({
  repo: z.string().describe("The repository, as owner/name."),
  tag: z.string().describe("The git tag name of the release."),
  commit: z.string().describe("The commit the tag names."),
  url: z.string().describe("The release's page on GitHub."),
  latest: z.boolean().describe("Whether this release is now the latest release."),
  foreign: z.boolean().describe("Whether the repository differs from the working tree's repository."),
})

export const releasePublish = defineTool({
  id: "github_release_publish",
  title: "Publish a GitHub release",
  intent: "About to publish a GitHub release",
  description:
    "Publish a draft release: creates its tag (pinned to the commit it would name) or uses the existing one, and notifies everyone watching; cannot be undone in effect. Refuses a published release, a target branch that is gone, and with head_sha a commit other than the one reviewed (stale). Read the commit to pass with github_release_read view.",
  toolset: "releases",
  class: "administrative",
  targets: githubTargets({ repo: "repo" }),
  async describe(args, ctx) {
    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }

    const { repo, current } = await describedRelease(args, ctx)
    if (!current.draft) {
      throw invalid(`Release ${args.tag} of ${repo.full} is published already.`)
    }
    if (args.latest === true && current.prerelease) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }

    const { commit, tagExists } = await publishCommit(repo, current, ctx)
    if (!commit) {
      throw invalid(
        `Release ${args.tag} of ${repo.full} targets ${current.target_commitish}, which is no longer a branch; set target with github_release_edit.`,
      )
    }
    if (expectedSha && commit.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `Release ${args.tag} of ${repo.full} would tag ${shortSha(commit)}, not ${shortSha(expectedSha)}: its target moved since it was read. Nothing was published.`,
      )
    }

    const facts: (CallFact | undefined)[] = [
      { label: "Tag", value: current.tag_name },
      {
        label: "Commit",
        value: tagExists ? { text: "{sha} (existing tag)", values: { sha: shortSha(commit) } } : shortSha(commit),
      },
      { label: "Latest", value: switchValue(args.latest ?? !current.prerelease) },
      current.prerelease ? { label: "Prerelease", value: switchValue(true) } : undefined,
    ]
    return {
      ...releaseHeadline("About to publish the release {name}", current),
      facts: facts.filter((fact): fact is CallFact => fact !== undefined),
      pins: { head_sha: commit },
    }
  },
  input,
  output,
  async execute(args, ctx) {
    const expectedSha = given(args.head_sha)
    if (args.head_sha !== undefined && (!expectedSha || !SHA_PATTERN.test(expectedSha))) {
      throw invalid("head_sha must be a full commit SHA of 40 hexadecimal characters.")
    }

    const context = await writableContext(await resolveRepo(args.repo, ctx), ctx)
    const repo = context.repo
    const current = await findRelease(repo, args.tag, ctx)
    if (!current) {
      throw releaseNotFound(repo, args.tag)
    }

    if (!current.draft) {
      throw invalid(`Release ${args.tag} of ${repo.full} is published already.`)
    }

    if (args.latest === true && current.prerelease) {
      throw invalid(PRERELEASE_CANNOT_BE_LATEST)
    }

    const { commit, tagExists } = await publishCommit(repo, current, ctx)
    if (!commit) {
      throw invalid(
        `Release ${args.tag} of ${repo.full} targets ${current.target_commitish}, which is no longer a branch; set target with github_release_edit.`,
      )
    }

    if (expectedSha && commit.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ToolError(
        "stale",
        `Release ${args.tag} of ${repo.full} would tag ${shortSha(commit)}, not ${shortSha(expectedSha)}: its target moved since it was read. Nothing was published.`,
      )
    }

    await confirmWrite(
      releasePublish,
      ctx,
      `Publish the release ${args.tag} of ${repo.full}? ${tagExists ? `Its tag already names ${shortSha(commit)}` : `It creates the tag at ${shortSha(commit)}`}, and everyone watching the repository is notified.`,
    )

    const body: ReleaseBody = {
      draft: false,
      ...(!tagExists ? { target_commitish: commit } : {}),
      ...(args.latest !== undefined ? { make_latest: args.latest ? "true" : "false" } : {}),
    }

    const published = await updateRelease(repo, current, body, ctx)
    const latestId = await latestReleaseId(repo, ctx)
    const latest = latestId !== null && published.id === latestId

    return {
      repo: repo.full,
      tag: published.tag_name,
      commit,
      url: published.html_url,
      latest,
      foreign: context.foreign,
    }
  },
})
