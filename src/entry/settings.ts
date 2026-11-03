import { TOOLSETS, ToolError, type ToolSettings, type Toolset } from "../core"

/** Who asks the person before an administrative tool acts: the harness, or the tool through the client's form. */
export type ConfirmMode = "harness" | "elicitation"

export type EntrySettings = ToolSettings & { confirm: ConfirmMode }

const CONFIRM_MODES: readonly ConfirmMode[] = ["harness", "elicitation"]
const ALL_TOOLSETS = "all"
const TRUE_VALUES: readonly string[] = ["1", "true"]
const FALSE_VALUES: readonly string[] = ["0", "false"]

type OptionName = "toolsets" | "read_only" | "tools" | "exclude_tools" | "confirm"

/** A setting's command-line flag and environment variable; a boolean flag takes no value. */
type Option = { flag: string; env: string; boolean?: true }

const OPTIONS: Record<OptionName, Option> = {
  toolsets: { flag: "--toolsets", env: "AGENT_GITHUB_TOOLSETS" },
  read_only: { flag: "--read-only", env: "AGENT_GITHUB_READ_ONLY", boolean: true },
  tools: { flag: "--tools", env: "AGENT_GITHUB_TOOLS" },
  exclude_tools: { flag: "--exclude-tools", env: "AGENT_GITHUB_EXCLUDE_TOOLS" },
  confirm: { flag: "--confirm", env: "AGENT_GITHUB_CONFIRM" },
}

function readFlags(argv: string[]): Partial<Record<OptionName, string>> {
  const byFlag = new Map(
    (Object.keys(OPTIONS) as OptionName[]).map((name) => [OPTIONS[name].flag, { name, ...OPTIONS[name] }]),
  )
  const given: Partial<Record<OptionName, string>> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const option = byFlag.get(flag)
    if (!arg.startsWith("--") || !option) throw new ToolError("invalid_argument", `Unknown option "${arg}".`)
    if (option.boolean) {
      if (equals !== -1) throw new ToolError("invalid_argument", `Option ${flag} takes no value.`)
      given[option.name] = "true"
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new ToolError("invalid_argument", `Option ${flag} needs a value.`)
    }
    given[option.name] = value
  }
  return given
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

function parseToolsets(value: string, source: string): Toolset[] | "all" | undefined {
  const names = splitList(value)
  if (names.includes(ALL_TOOLSETS)) return ALL_TOOLSETS
  const unknown = names.find((name) => !(TOOLSETS as readonly string[]).includes(name))
  if (unknown !== undefined) {
    throw new ToolError(
      "invalid_argument",
      `Unknown toolset "${unknown}" in ${source}; use one of ${TOOLSETS.join(", ")} or "${ALL_TOOLSETS}".`,
    )
  }
  return names.length ? (names as Toolset[]) : undefined
}

function parseBoolean(value: string, source: string): boolean {
  const text = value.trim().toLowerCase()
  if (TRUE_VALUES.includes(text)) return true
  if (FALSE_VALUES.includes(text)) return false
  throw new ToolError(
    "invalid_argument",
    `Unknown value "${value}" in ${source}; use one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}.`,
  )
}

function parseConfirm(value: string, source: string): ConfirmMode {
  const mode = CONFIRM_MODES.find((candidate) => candidate === value)
  if (!mode) {
    throw new ToolError(
      "invalid_argument",
      `Unknown confirm mode "${value}" in ${source}; use one of ${CONFIRM_MODES.join(", ")}.`,
    )
  }
  return mode
}

/**
 * Reads the settings every entry point takes from its command line and
 * environment. A flag wins over its environment variable; an empty list
 * item is dropped. A mistake is `invalid_argument` naming the culprit.
 */
export function parseSettings(argv: string[], env: Record<string, string | undefined>): EntrySettings {
  const flags = readFlags(argv)
  const value = (name: OptionName): { text: string; source: string } | undefined => {
    const option = OPTIONS[name]
    if (flags[name] !== undefined) return { text: flags[name], source: option.flag }
    const fromEnv = env[option.env]
    return fromEnv === undefined || fromEnv.trim() === "" ? undefined : { text: fromEnv, source: option.env }
  }

  const settings: EntrySettings = { confirm: "harness" }
  const toolsets = value("toolsets")
  if (toolsets) settings.toolsets = parseToolsets(toolsets.text, toolsets.source)
  const readOnly = value("read_only")
  if (readOnly) settings.read_only = parseBoolean(readOnly.text, readOnly.source)
  const tools = value("tools")
  if (tools) settings.tools = splitList(tools.text)
  const excluded = value("exclude_tools")
  if (excluded) settings.exclude_tools = splitList(excluded.text)
  const confirm = value("confirm")
  if (confirm) settings.confirm = parseConfirm(confirm.text.trim(), confirm.source)
  return settings
}
