import { invoke, isToolError, selectTools, type ToolContext, type ToolSpec } from "../core"
import { ANY_RESOURCE } from "../entry/permission"
import { settingsFromOptions } from "../entry/settings"
import type { PluginOptions } from "./types"

/** What a plugin takes from its surroundings; each has a default, and a test supplies its own. */
export type PluginDeps = {
  /** Where the `AGENT_GITHUB_*` settings fall back to; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The directory holding `<name>/SKILL.md` files, for the harness version that registers skills. */
  skillsDir?: URL | string
}

/** The one plain line a person reads when the harness asks to run a tool. */
export function permissionMessage(spec: Pick<ToolSpec, "title">, resource: string): string {
  return resource === ANY_RESOURCE ? spec.title : `${spec.title} on ${resource}`
}

/** What the harness is told about a call it is asked to allow. */
export function permissionMetadata(spec: Pick<ToolSpec, "title" | "class">, args: unknown, resource: string) {
  return { arguments: args, class: spec.class, message: permissionMessage(spec, resource) }
}

/** Whether a call must be allowed by the harness first: every tool but a read tool. */
export function needsPermission(spec: Pick<ToolSpec, "class">): boolean {
  return spec.class !== "read"
}

/** The tools the plugin options (and the environment behind them) select from `specs`. */
export function selectedTools(
  specs: ToolSpec[],
  options: PluginOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): ToolSpec[] {
  return selectTools(specs, settingsFromOptions(options, env))
}

/** Runs a tool through core `invoke`; a tool failure reaches the harness as an `Error` reading `<code>: <message>`. */
export async function runTool(spec: ToolSpec, args: unknown, ctx: ToolContext): Promise<unknown> {
  try {
    return await invoke(spec, args, ctx)
  } catch (error) {
    if (!isToolError(error)) throw error
    throw new Error(`${error.code}: ${error.message}`, { cause: error })
  }
}
