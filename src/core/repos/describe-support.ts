import { readAdministeredRepository, type Visibility } from "../github/repos"
import { resolveRepo, type RepoName } from "../refs"
import type { CallFact, CallHeadline, ToolContext } from "../tool"
import { writableContext } from "../write-support"

/** What a description of a repository tool reads: the repository a call means, found as `execute` finds it. */

/** The visibilities as a fact shows them, as words of the tool's. */
const VISIBILITY_WORDS: Readonly<Record<Visibility, string>> = {
  public: "Public",
  private: "Private",
  internal: "Internal",
}

/** Each change of visibility as a fact shows it, written out so each translates as a whole. */
const TRANSITION_WORDS: Readonly<Record<Visibility, Partial<Record<Visibility, string>>>> = {
  public: { private: "Public to private", internal: "Public to internal" },
  private: { public: "Private to public", internal: "Private to internal" },
  internal: { public: "Internal to public", private: "Internal to private" },
}

/**
 * The repository a call means, resolved and read exactly as `execute` reads it:
 * what GitHub knows it by (`view.repo`, its visibility, whether it is archived)
 * and the viewer's admin permission checked. Reads only.
 */
export async function describedRepo(args: { repo?: string }, ctx: ToolContext) {
  return readAdministeredRepository(await resolveRepo(args.repo, ctx), ctx)
}

/** The repository a label or milestone call means, resolved as `execute` resolves it, once the viewer may write there. Reads only. */
export async function describedWritableRepo(args: { repo?: string }, ctx: ToolContext): Promise<RepoName> {
  return (await writableContext(await resolveRepo(args.repo, ctx), ctx)).repo
}

/** The headline of a call on the repository, `text` with the full name GitHub gives it for `{name}`. */
export function repoHeadline(text: string, fullName: string): { headline: CallHeadline } {
  return { headline: { text, values: { name: fullName } } }
}

/** The `Visibility` fact of a repository that stays as it is. */
export function visibilityFact(visibility: Visibility): CallFact {
  return { label: "Visibility", value: { text: VISIBILITY_WORDS[visibility] } }
}

/** The `Visibility` fact of a repository that changes from one visibility to another. */
export function transitionFact(from: Visibility, to: Visibility): CallFact {
  const text = TRANSITION_WORDS[from][to]
  return text === undefined ? visibilityFact(to) : { label: "Visibility", value: { text } }
}
