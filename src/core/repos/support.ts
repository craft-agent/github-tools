import { invalid } from "../issues/write-support"

/** What the repository tools share: the argument text, the list cap and the refusal of another method's argument. */

export const REPO_DESCRIPTION = "owner/name; defaults to the working tree's repository (its origin)."

/** The most items a list returns. */
export const MAX_LIST_LIMIT = 1000

/**
 * Throws `invalid_argument` when `args` holds an argument that belongs to
 * another method than `args.method` and not to this one.
 * `methodArguments` lists what each method takes besides `method`.
 */
export function refuseOtherMethod<M extends string>(
  args: { method: M } & Record<string, unknown>,
  methodArguments: Readonly<Record<M, readonly string[]>>,
): void {
  const allowed = methodArguments[args.method]
  const misplaced = Object.keys(args).find(
    (name) => name !== "method" && args[name] !== undefined && !allowed.includes(name),
  )
  if (!misplaced) return
  const owners = (Object.keys(methodArguments) as M[]).filter((method) => methodArguments[method].includes(misplaced))
  if (owners.length === 0) return
  throw invalid(
    `"${misplaced}" is an argument of method ${owners.map((method) => `"${method}"`).join(" or ")}, not "${args.method}"; leave it out.`,
  )
}
