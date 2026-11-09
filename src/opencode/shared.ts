import {
  ENGLISH,
  invoke,
  isToolError,
  selectTools,
  type ToolContext,
  type ToolSpec,
  type Translations,
  type Translator,
} from "../core"
import { approvalPrompt, standIn, type ShownDescription } from "../entry/description"
import { errorText } from "../entry/errors"
import { ANY_RESOURCE } from "../entry/permission"
import { settingsFromOptions } from "../entry/settings"
import { promptTranslator, promptWords } from "../entry/words"
import type { PluginOptions } from "./types"

/** What a plugin takes from its surroundings; each has a default, and a test supplies its own. */
export type PluginDeps = {
  /** Where the `GITHUB_TOOLS_*` settings fall back to; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The directory holding `<name>/SKILL.md` files, for the harness version that registers skills. */
  skillsDir?: URL | string
  /** Where the plugin is installed: never a call's working tree, so a bare number there fails. */
  ownDir?: string
  /** The translations of the tools' words, per language, for the approval prompt; defaults to none, which keeps it in English. */
  translations?: Translations
}

/** The resources an "always" answer may persist: all but `*`, which would grant every repository. */
export function persistableResources(resources: string[]): string[] {
  return resources.filter((resource) => resource !== ANY_RESOURCE)
}

/** What the harness is told about a call it is asked to allow. */
export function permissionMetadata(
  spec: Pick<ToolSpec, "title" | "intent" | "class">,
  args: unknown,
  resources: string[],
  description?: ShownDescription,
  t: Translator = ENGLISH,
) {
  return {
    arguments: args,
    class: spec.class,
    message: approvalPrompt(standIn(spec, t), resources, description, promptWords(t)),
  }
}

/** Whether a call must be allowed by the harness first: every tool but a read tool. */
export function needsPermission(spec: Pick<ToolSpec, "class">): boolean {
  return spec.class !== "read"
}

/**
 * The tools the plugin options (and the environment behind them) select from
 * `specs`, and the translator of the prompt language they set over the
 * plugin's translations.
 */
export function selectedTools(
  specs: ToolSpec[],
  options: PluginOptions | undefined,
  deps: PluginDeps,
): { specs: ToolSpec[]; translator: Translator } {
  const settings = settingsFromOptions(options, deps.env ?? process.env)
  return {
    specs: selectTools(specs, settings),
    translator: promptTranslator(deps.translations ?? {}, settings.language),
  }
}

/**
 * Runs a tool through core `invoke`; a tool failure reaches the harness as an
 * `Error` reading `<code>: <message>`, with `details` as JSON on a line of its
 * own when set.
 */
export async function runTool(spec: ToolSpec, args: unknown, ctx: ToolContext): Promise<unknown> {
  try {
    return await invoke(spec, args, ctx)
  } catch (error) {
    if (!isToolError(error)) throw error
    throw new Error(errorText(error), { cause: error })
  }
}
