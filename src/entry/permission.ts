import { ANY_TARGET, writeTargets, type RefContext, type ToolSpec } from "../core"

/** What a permission rule matches when a repository the call writes to cannot be told. */
export const ANY_RESOURCE = ANY_TARGET

/**
 * The resources a permission rule matches: every repository the call writes
 * to, in lowercase (see `writeTargets`), with `*` for one that cannot be told;
 * the call then fails its own way.
 */
export function permissionResources(
  spec: Pick<ToolSpec, "targets">,
  args: unknown,
  ctx: RefContext,
): Promise<string[]> {
  return writeTargets(spec, args, ctx)
}
