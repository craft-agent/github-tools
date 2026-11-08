import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "./errors"

export const TOOLSETS = ["issues", "pull_requests", "projects", "repos", "releases", "actions"] as const

export type Toolset = (typeof TOOLSETS)[number]

/** The toolsets that are on when a setting does not name any. */
export const DEFAULT_TOOLSETS: Toolset[] = ["issues", "pull_requests", "projects"]

/** How far a tool's effect reaches; `docs/conventions.md` defines each class and its annotations. */
export type WriteClass = "read" | "add" | "idempotent" | "overwrite" | "administrative"

export type ConfirmRequest = { tool: string; message: string }

/**
 * What an argument that names what a call writes to holds: `"repo"` an
 * `owner/name`, `"issue"` one issue reference (`12`, `#12`, `owner/repo#12` or
 * a URL), `"issues"` a list of them, `"board"` the board that `project` (a
 * reference or a title), `owner` and `repo` choose together (declared on
 * `project`), `"item"` a project item's node ID (`PVTI_…`), whose board is
 * written to, `"owner"` a user or organization login (or `@me`) that a board is
 * about to be created for, `"pull"` one pull request reference (`12`, `#12`,
 * `owner/repo#12` or a pull URL), `"optional_board"` a board that `project`
 * names, which the call writes to only when the argument is given, `"run"`
 * a workflow run id or a run URL.
 */
export type TargetKind = "repo" | "issue" | "issues" | "pull" | "board" | "optional_board" | "item" | "owner" | "run"

/** One fact an approval prompt shows of a call, read as `Label: value`. */
export type CallFact = { label: string; value: string }

/** A headline template the tool picks, such as `Create the note {name}`, and the values the entry point quotes into it. */
export type CallHeadline = { text: string; values?: Record<string, string> }

/** The text a call carries, under the tool's own label (`Note text`). */
export type CallText = { label: string; body: string }

/** What a call will do, as an approval prompt shows it: an optional headline, short facts, then an optional text. */
export type CallDescription = { headline?: CallHeadline; facts: CallFact[]; text?: CallText }

export type ToolContext = {
  /** The working directory the call runs in; a bare issue number means this tree's repository. */
  cwd: string
  /** A directory that is never the caller's working tree (where these tools are installed); a bare number there fails. */
  ownDir?: string
  signal?: AbortSignal
  /** Asks the person to approve; absent when the harness's own approval already covers the call. */
  confirm?(request: ConfirmRequest): Promise<boolean>
}

export type ToolSpec<I extends z.ZodObject<any> = z.ZodObject<any>, O extends z.ZodObject<any> = z.ZodObject<any>> = {
  /** `github_<domain>_<verb>`; a public interface, so it never changes once published. */
  id: string
  title: string
  description: string
  toolset: Toolset
  class: WriteClass
  /** The arguments that name a repository or board the call writes to, by name; each must be an argument of `input`. */
  targets?: Readonly<Record<string, TargetKind>>
  /**
   * What the call will do, for the person approving it: a headline template
   * (the title stands without one), facts such as the kind of target, and the
   * text the call carries under the tool's own label.
   */
  describe?(args: z.output<I>, ctx: ToolContext): CallDescription | Promise<CallDescription>
  input: I
  output: O
  execute(args: z.output<I>, ctx: ToolContext): Promise<z.input<O>>
}

/** A client meta key that makes the client ask even under an allow rule. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"

const TOOL_ID_PATTERN = /^github_[a-z]+(?:_[a-z]+)+$/
const MAX_TOOL_ID_LENGTH = 40
const READ_TOOL_SUFFIX = "_read"

/**
 * Returns the spec after checking what a type cannot: the ID's shape and
 * length, that a read tool is named `_read`, that the output schema is an
 * object (a tool returns its data as a plain object), and that every target
 * is an argument of the input.
 */
export function defineTool<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  spec: ToolSpec<I, O>,
): ToolSpec<I, O> {
  if (!TOOL_ID_PATTERN.test(spec.id)) {
    throw new Error(`Tool id "${spec.id}" must look like github_<domain>_<verb> in lowercase letters.`)
  }
  if (spec.id.length > MAX_TOOL_ID_LENGTH) {
    throw new Error(`Tool id "${spec.id}" is longer than ${MAX_TOOL_ID_LENGTH} characters.`)
  }
  if (spec.class === "read" && !spec.id.endsWith(READ_TOOL_SUFFIX)) {
    throw new Error(`Tool "${spec.id}" is a read tool, so its id must end in ${READ_TOOL_SUFFIX}.`)
  }
  if (!(spec.output instanceof z.ZodObject)) {
    throw new Error(`Tool "${spec.id}" must have an object output schema, since a result is an object.`)
  }
  const unknownTarget = Object.keys(spec.targets ?? {}).find((name) => !Object.hasOwn(spec.input.shape, name))
  if (unknownTarget !== undefined) {
    throw new Error(`Tool "${spec.id}" declares the target "${unknownTarget}", which is not one of its arguments.`)
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

function describeIssues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      const path = issue.path.map(String)
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${[...path, key].join(".")}: unknown argument`)
      }
      return path.length ? `${path.join(".")}: ${issue.message}` : issue.message
    })
    .join("; ")
}

const MAX_RESULT_JSON_LENGTH = 2000

function describeResult(result: unknown): string {
  let json: string
  try {
    json = JSON.stringify(result) ?? String(result)
  } catch {
    json = String(result)
  }
  return json.length > MAX_RESULT_JSON_LENGTH ? `${json.slice(0, MAX_RESULT_JSON_LENGTH)}…` : json
}

/**
 * Runs a tool the way every entry point does: validates the raw arguments
 * as strict (`invalid_argument` on a bad or unknown one), executes, and
 * validates the result against the output schema. A result that does not
 * match is a bug in the tool; it throws `github_error` carrying the raw
 * result, so whatever the call already created stays visible. Errors from
 * `execute` pass through unchanged.
 */
export async function invoke<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  spec: ToolSpec<I, O>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<z.output<O>> {
  const args = spec.input.strict().safeParse(rawArgs)
  if (!args.success) {
    throw new ToolError("invalid_argument", `Invalid arguments for ${spec.id}: ${describeIssues(args.error)}`, {
      cause: args.error,
    })
  }
  const result = await spec.execute(args.data as z.output<I>, ctx)
  const output = spec.output.safeParse(result)
  if (!output.success) {
    throw new ToolError(
      "github_error",
      `${spec.id} returned a result that does not match its output schema (${describeIssues(output.error)}). The call may have gone through; its result was: ${describeResult(result)}`,
      { cause: output.error },
    )
  }
  return output.data
}

export function inputJsonSchema(spec: Pick<ToolSpec, "input">): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(spec.input, { io: "input" })
}

export function outputJsonSchema(spec: Pick<ToolSpec, "output">): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(spec.output)
}

/**
 * Collects the failures of steps that run after a tool has already created
 * something, so those steps never throw and the creation is not lost: the
 * result lists them under `errors`, keyed by step. A cancellation is never
 * recorded; it is rethrown.
 */
export class StepErrors {
  readonly #errors: Record<string, string> = {}

  /** Runs one step; a failure is recorded under `step` and the step yields `undefined`. */
  async record<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      if (isAbortError(error)) throw error
      this.#errors[step] = isToolError(error)
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
      return undefined
    }
  }

  get errors(): Record<string, string> {
    return { ...this.#errors }
  }

  get any(): boolean {
    return Object.keys(this.#errors).length > 0
  }
}
