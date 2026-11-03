import { isAbortError, resolveRepo, type ToolContext } from "../core"

/** What a permission rule matches when the call's target repository cannot be told. */
export const ANY_RESOURCE = "*"

/**
 * The resource a permission rule matches: the repository the call targets, in
 * lowercase (its `repo` argument, or else the working tree's `origin`). When
 * that cannot be resolved the resource is `*`, and the call fails its own way.
 */
export async function permissionResource(args: unknown, ctx: Pick<ToolContext, "cwd" | "signal">): Promise<string> {
  const repo = typeof args === "object" && args !== null ? (args as { repo?: unknown }).repo : undefined
  if (repo !== undefined && typeof repo !== "string") return ANY_RESOURCE
  try {
    return (await resolveRepo(repo, ctx)).full.toLowerCase()
  } catch (error) {
    if (isAbortError(error)) throw error
    return ANY_RESOURCE
  }
}
