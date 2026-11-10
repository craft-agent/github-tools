import { findRelease, releaseNotFound, type RestRelease } from "../github/releases"
import { resolveRepo, type RepoName } from "../refs"
import type { CallHeadline, CallValue, ToolContext } from "../tool"
import { writableContext } from "../write-support"

/** What a description of a release tool reads: the release a call means, found as `execute` finds it. */

/**
 * The release a call on `args.tag` means, found as `execute` finds it, once the
 * viewer may write to the repository; a release that does not exist is
 * `not_found`. Reads only.
 */
export async function describedRelease(
  args: { repo?: string; tag: string },
  ctx: ToolContext,
): Promise<{ repo: RepoName; current: RestRelease }> {
  const { repo } = await writableContext(await resolveRepo(args.repo, ctx), ctx)
  const current = await findRelease(repo, args.tag, ctx)
  if (!current) throw releaseNotFound(repo, args.tag)
  return { repo, current }
}

/** What a release is called: its name, or its tag when it has none. */
export function releaseName(release: Pick<RestRelease, "name" | "tag_name">): string {
  return release.name || release.tag_name
}

/** The headline of a call on a release, `text` with the name for `{name}`. */
export function releaseHeadline(
  text: string,
  release: Pick<RestRelease, "name" | "tag_name">,
): {
  headline: CallHeadline
} {
  return { headline: { text, values: { name: releaseName(release) } } }
}

/** A switch as a fact shows it, as words of the tool's. */
export function switchValue(on: boolean): CallValue {
  return { text: on ? "On" : "Off" }
}
