import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "./errors"

export const TOOLSETS = ["issues", "pull_requests", "projects", "repos", "releases", "actions"] as const

export type Toolset = (typeof TOOLSETS)[number]

/** The toolsets that are on when a setting does not name any. */
export const DEFAULT_TOOLSETS: Toolset[] = ["issues", "pull_requests"]

/** How far a tool's effect reaches; `docs/conventions.md` defines each class and its annotations. */
export type WriteClass = "read" | "add" | "idempotent" | "overwrite" | "administrative"

export type ConfirmRequest = { tool: string; message: string }

export type ToolContext = {
  /** The working directory the call runs in; a bare issue number means this tree's repository. */
  cwd: string
  signal?: AbortSignal
  /** Asks the person to approve; absent when the harness's own approval already covers the call. */
  confirm?(request: ConfirmRequest): Promise<boolean>
}

export type ToolSpec<I extends z.ZodObject<any> = z.ZodObject<any>, O extends z.ZodType = z.ZodType> = {
  /** `github_<domain>_<verb>`; a public interface, so it never changes once published. */
  id: string
  title: string
  description: string
  toolset: Toolset
  class: WriteClass
  input: I
  output: O
  execute(args: z.output<I>, ctx: ToolContext): Promise<z.input<O>>
}

/** A client meta key that makes the client ask even under an allow rule. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"

const TOOL_ID_PATTERN = /^github_[a-z]+(?:_[a-z]+)+$/
const MAX_TOOL_ID_LENGTH = 40
const READ_TOOL_SUFFIX = "_read"

/** Returns the spec after checking what a type cannot: the ID's shape and length, and that a read tool is named `_read`. */
export function defineTool<I extends z.ZodObject<any>, O extends z.ZodType>(spec: ToolSpec<I, O>): ToolSpec<I, O> {
  if (!TOOL_ID_PATTERN.test(spec.id)) {
    throw new Error(`Tool id "${spec.id}" must look like github_<domain>_<verb> in lowercase letters.`)
  }
  if (spec.id.length > MAX_TOOL_ID_LENGTH) {
    throw new Error(`Tool id "${spec.id}" is longer than ${MAX_TOOL_ID_LENGTH} characters.`)
  }
  if (spec.class === "read" && !spec.id.endsWith(READ_TOOL_SUFFIX)) {
    throw new Error(`Tool "${spec.id}" is a read tool, so its id must end in ${READ_TOOL_SUFFIX}.`)
  }
  return spec
}

export type ToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint: boolean
  openWorldHint: true
}

const CLASS_HINTS = {
  read: { readOnlyHint: true, idempotentHint: true },
  add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  idempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  overwrite: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  administrative: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
} as const satisfies Record<WriteClass, Omit<ToolAnnotations, "title" | "openWorldHint">>

/** The MCP annotations of a tool's write class. */
export function annotations(spec: Pick<ToolSpec, "title" | "class">): ToolAnnotations {
  return { title: spec.title, ...CLASS_HINTS[spec.class], openWorldHint: true }
}

/** The `_meta` an entry point publishes with the tool; only administrative tools carry any. */
export function toolMeta(spec: Pick<ToolSpec, "class">): Record<string, unknown> | undefined {
  return spec.class === "administrative" ? { [REQUIRES_USER_INTERACTION]: true } : undefined
}

/**
 * Asks the person before an administrative tool acts. Other classes never ask,
 * and a missing `ctx.confirm` means the harness's approval already covered the
 * call. Anything but an accept throws `declined`.
 */
export async function confirmWrite(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: Pick<ToolContext, "confirm">,
  message: string,
): Promise<void> {
  if (spec.class !== "administrative" || !ctx.confirm) return
  if ((await ctx.confirm({ tool: spec.id, message })) !== true) {
    throw new ToolError("declined", `${spec.id} was declined: ${message}`)
  }
}

/** The settings every entry point takes. */
export type ToolSettings = {
  /** The toolsets that are on; `"all"` turns on every one. Absent or empty means `DEFAULT_TOOLSETS`. */
  toolsets?: Toolset[] | "all"
  /** Registers no write tool, and wins over every other setting. */
  read_only?: boolean
  /** Single tools to add, by id, whatever their toolset. */
  tools?: string[]
  /** Single tools to remove, by id; wins over `tools` and `toolsets`. */
  exclude_tools?: string[]
}

function knownIds(setting: string, ids: string[], known: ReadonlySet<string>): void {
  const unknown = ids.find((id) => !known.has(id))
  if (unknown !== undefined) throw new ToolError("invalid_argument", `Unknown tool "${unknown}" in ${setting}.`)
}

/** The tools the settings turn on, in the order of `all`. */
export function selectTools<S extends Pick<ToolSpec, "id" | "toolset" | "class">>(
  all: S[],
  settings: ToolSettings = {},
): S[] {
  const ids = new Set<string>()
  for (const spec of all) {
    if (ids.has(spec.id)) throw new Error(`Duplicate tool id "${spec.id}".`)
    ids.add(spec.id)
  }

  const requested = settings.toolsets?.length === 0 ? undefined : settings.toolsets
  const toolsets: ReadonlySet<string> = new Set(requested === "all" ? TOOLSETS : (requested ?? DEFAULT_TOOLSETS))
  const unknownToolset = [...toolsets].find((name) => !(TOOLSETS as readonly string[]).includes(name))
  if (unknownToolset !== undefined) {
    throw new ToolError(
      "invalid_argument",
      `Unknown toolset "${unknownToolset}"; use one of ${TOOLSETS.join(", ")} or "all".`,
    )
  }
  const added = settings.tools ?? []
  const excluded = new Set(settings.exclude_tools ?? [])
  knownIds("tools", added, ids)
  knownIds("exclude_tools", [...excluded], ids)

  return all.filter(
    (spec) =>
      (toolsets.has(spec.toolset) || added.includes(spec.id)) &&
      !excluded.has(spec.id) &&
      !(settings.read_only && spec.class !== "read"),
  )
}
