import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  PIN_PATTERN,
  ToolError,
  abortError,
  annotations,
  defineTool,
  selectTools,
  type ToolSpec,
  type Translations,
} from "../core"
import { tempRepo } from "../testing/git-repo"
import { PROJECT_PROFILE } from "../entry/profile"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from "./cli"

const input = z.object({
  repo: z.string().describe("The repository, as owner/name.").optional(),
  count: z.number().int().optional(),
})
const output = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})
const writeInput = input.extend({ issue: z.string().optional(), parent: z.string().optional() })

const READ_ID = "github_issue_read"
const ADD_ID = "github_issue_comment"
const ADMIN_ID = "github_release_publish"
const MISSING_ID = "github_issue_close"
const BROKEN_ID = "github_issue_reopen"
const SLOW_ID = "github_issue_lock"
const DETAILED_ID = "github_issue_validate"
const DESCRIBED_ID = "github_issue_label"
const HANGING_DESCRIBE_ID = "github_issue_pin"

function fixture(id: string, toolset: ToolSpec["toolset"], writeClass: ToolSpec["class"]): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(id === ADD_ID && { targets: { issue: "issue", repo: "repo", parent: "issue" } as const }),
    input: id === ADD_ID ? writeInput : input,
    output,
    async execute(args, ctx) {
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

function failingWith(id: string, writeClass: ToolSpec["class"], fail: (signal?: AbortSignal) => Promise<never>) {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "issues",
    class: writeClass,
    input,
    output,
    execute: (_args, ctx) => fail(ctx.signal),
  })
}

function describing(id: string, describe: ToolSpec["describe"]): ToolSpec {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "issues",
    class: "add",
    targets: { repo: "repo" },
    input,
    output,
    describe,
    async execute(args, ctx) {
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

const specs: ToolSpec[] = [
  fixture(READ_ID, "issues", "read"),
  fixture(ADD_ID, "issues", "add"),
  fixture(ADMIN_ID, "releases", "administrative"),
  failingWith(MISSING_ID, "overwrite", async () => {
    throw new ToolError("not_found", "No such issue.")
  }),
  failingWith(BROKEN_ID, "overwrite", async () => {
    throw new TypeError("boom")
  }),
  failingWith(SLOW_ID, "idempotent", (signal) => {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(abortError(signal))
      signal?.addEventListener("abort", () => reject(abortError(signal)))
    })
  }),
  failingWith(DETAILED_ID, "overwrite", async () => {
    throw new ToolError("invalid_argument", "The thing has problems.", {
      details: { problems: [{ field: "name", reason: "empty" }] },
    })
  }),
  describing(DESCRIBED_ID, (args) => ({
    headline: { text: "Label the repository {repo}", values: { repo: String(args.repo ?? "here") } },
    facts: [{ label: "Repository", value: String(args.repo ?? "here") }],
    text: { label: "Body", body: "Body\u202E line\r\nnext" },
  })),
  describing(HANGING_DESCRIBE_ID, () => new Promise(() => {})),
]

const INTENT_ID = "github_issue_touch"
const INTENT = "About to touch the issue"

/** The Japanese of the intent fixture's intent. */
const INTENT_TRANSLATIONS: Translations = { ja: { [INTENT]: "イシューに触れようとしています" } }

/** The tools that carry an intent, to add after `specs`, which has none. */
const intentSpecs: ToolSpec[] = [
  defineTool({
    id: INTENT_ID,
    title: INTENT_ID,
    intent: INTENT,
    description: INTENT_ID,
    toolset: "issues",
    class: "add",
    targets: { repo: "repo" },
    input,
    output,
    async execute(args, ctx) {
      return { tool: INTENT_ID, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  }),
]

type Run = { code: number; stdout: string; stderr: string }

async function cli(argv: string[], stdin = "", overrides: Partial<CliIo> = {}): Promise<Run> {
  let stdout = ""
  let stderr = ""
  const code = await runCli(argv, {
    specs,
    env: {},
    readStdin: async () => stdin,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...overrides,
  })
  return { code, stdout, stderr }
}

const json = (run: Run): any => JSON.parse(run.stdout)

/** The plugin's own words in English, as `target` answers without a language. */
const ENGLISH_WORDS = {
  details: "Details",
  target: "Target",
  more: "(+{count} more)",
  more_character: "(+{count} more character)",
  more_characters: "(+{count} more characters)",
}
const JAPANESE_WORDS = {
  details: "詳細",
  target: "対象",
  more: "（ほか {count} 件）",
  more_character: "（ほか {count} 文字）",
  more_characters: "（ほか {count} 文字）",
}

/** Japanese words for the described fixture's title, headline, fact label and text label. */
const TRANSLATIONS: Translations = {
  ja: {
    [DESCRIBED_ID]: "ラベル付け",
    "Label the repository {repo}": "リポジトリ {repo} にラベルを付ける",
    Repository: "リポジトリ",
    Body: "本文",
  },
}

/** The titles of the fixtures that are not `Title of <id>`: the id itself. */
const OWN_ID_TITLES = [DESCRIBED_ID, HANGING_DESCRIBE_ID]

/** The answer of `target` without a language for a fixture: its resources, its English title and the English words. */
const answer = (id: string, resources: string[]) => ({
  resources,
  title: OWN_ID_TITLES.includes(id) ? id : `Title of ${id}`,
  words: ENGLISH_WORDS,
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("list", () => {
  test("describes the tools the settings select, in order", async () => {
    const run = await cli(["list"])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    const listed = json(run)
    expect(listed.map((entry: { id: string }) => entry.id)).toEqual(
      selectTools(specs, {}, PROJECT_PROFILE.toolsets).map((spec) => spec.id),
    )
    expect(listed[0]).toEqual({
      id: READ_ID,
      title: `Title of ${READ_ID}`,
      description: `Description of ${READ_ID}`,
      toolset: "issues",
      class: "read",
      annotations: annotations(specs[0]!),
      input_schema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({ repo: expect.objectContaining({ description: expect.any(String) }) }),
      }),
      output_schema: expect.objectContaining({ type: "object" }),
    })
  })

  test("follows the settings flags", async () => {
    const ids = async (...flags: string[]) =>
      json(await cli(["list", ...flags])).map((entry: { id: string }) => entry.id)
    expect(await ids("--toolsets", "all")).toContain(ADMIN_ID)
    expect(await ids("--toolsets=releases")).toEqual([ADMIN_ID])
    expect(await ids("--toolsets", "all", "--read-only")).toEqual([READ_ID])
    expect(await ids("--tools", ADMIN_ID, "--exclude-tools", READ_ID)).toEqual([
      ADD_ID,
      ADMIN_ID,
      MISSING_ID,
      BROKEN_ID,
      SLOW_ID,
      DETAILED_ID,
      DESCRIBED_ID,
      HANGING_DESCRIBE_ID,
    ])
    expect(await ids("--exclude-tools", `${READ_ID},${ADD_ID}`)).toEqual([
      MISSING_ID,
      BROKEN_ID,
      SLOW_ID,
      DETAILED_ID,
      DESCRIBED_ID,
      HANGING_DESCRIBE_ID,
    ])
  })

  test("reads the environment behind the flags", async () => {
    const run = await cli(["list"], "", { env: { GITHUB_TOOLS_TOOLSETS: "releases" } })
    expect(json(run).map((entry: { id: string }) => entry.id)).toEqual([ADMIN_ID])
  })

  test("lists nothing as an empty array", async () => {
    expect(json(await cli(["list", "--toolsets", "projects"]))).toEqual([])
  })
})

describe("run", () => {
  test("passes the arguments from stdin and the directory, and answers with the result", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], JSON.stringify({ count: 3 }))
    expect(run).toEqual({
      code: EXIT_OK,
      stdout: `${JSON.stringify({ result: { tool: ADD_ID, cwd: "/work/tree", count: 3 } })}\n`,
      stderr: "",
    })
  })

  test("hands the install directory to the tool", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], "", { ownDir: "/opt/github-tools" })
    expect(json(run).result).toEqual({ tool: ADD_ID, cwd: "/work/tree", own_dir: "/opt/github-tools" })
  })

  test("takes --cwd after the settings flags and in its --cwd=dir form", async () => {
    const run = await cli(["run", ADMIN_ID, "--toolsets", "all", "--cwd=/x"])
    expect(json(run)).toEqual({ result: { tool: ADMIN_ID, cwd: "/x" } })
  })

  test("empty stdin is an empty object", async () => {
    expect(json(await cli(["run", READ_ID, "--cwd", "/x"], "  \n")).result.tool).toBe(READ_ID)
  })

  test("maps a tool failure to its code and message", async () => {
    const run = await cli(["run", MISSING_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({ error: { code: "not_found", message: "No such issue." } })
  })

  test("maps a tool failure with details to code, message and details", async () => {
    const run = await cli(["run", DETAILED_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({
      error: {
        code: "invalid_argument",
        message: "The thing has problems.",
        details: { problems: [{ field: "name", reason: "empty" }] },
      },
    })
  })

  test("rejects arguments the schema does not accept", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], JSON.stringify({ bogus: 1 }))
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
    expect(json(run).error.message).toContain("bogus")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("an unknown tool, and one the settings leave out, are invalid_argument", async () => {
    for (const argv of [
      ["run", "github_nonexistent_read", "--cwd", "/x"],
      ["run", ADMIN_ID, "--cwd", "/x"],
      ["run", ADD_ID, "--cwd", "/x", "--read-only"],
    ]) {
      const run = await cli(argv)
      expect(run.code).toBe(EXIT_FAILED)
      expect(json(run).error.code).toBe("invalid_argument")
      expect(json(run).error.message).toContain(argv[1]!)
    }
  })

  test("an unexpected error is generic on stdout and detailed on stderr", async () => {
    const run = await cli(["run", BROKEN_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("github_error")
    expect(json(run).error.message).not.toContain("boom")
    expect(run.stderr).toContain("boom")
  })

  test("stops a running tool when the signal aborts", async () => {
    const controller = new AbortController()
    const pending = cli(["run", SLOW_ID, "--cwd", "/x"], "", { signal: controller.signal })
    controller.abort()
    const run = await pending
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("github_error")
    expect(json(run).error.message).toContain("cancelled")
  })
})

describe("target", () => {
  test("includes the call's description with hidden characters marked and newlines normalized", async () => {
    const run = await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"repo":"Octo/Hello"}')
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual({
      ...answer(DESCRIBED_ID, ["octo/hello"]),
      description: {
        headline: 'Label the repository "Octo/Hello"',
        facts: [{ label: "Repository", value: "Octo/Hello" }],
        text: { label: "Body", body: "Body<U+202E> line\nnext" },
      },
      pin: expect.stringMatching(PIN_PATTERN),
    })
  })

  test("still answers resources without a description when describing never settles", async () => {
    const run = await cli(["target", HANGING_DESCRIBE_ID, "--cwd", "/x"], '{"repo":"Octo/Hello"}', {
      describeTimeoutMs: 50,
    })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual(answer(HANGING_DESCRIBE_ID, ["octo/hello"]))
  })

  test("omits the description and answers * for invalid arguments", async () => {
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"repo":3}'))).toEqual(answer(DESCRIBED_ID, ["*"]))
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual(answer(DESCRIBED_ID, ["*"]))
  })

  test("is the lowercased repo argument", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], JSON.stringify({ repo: "Octo/Hello" }))
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual(answer(ADD_ID, ["octo/hello"]))
  })

  test("is the working tree's origin without a repo argument", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir]))).toEqual(answer(ADD_ID, ["octo/hello"]))
  })

  test("is the repository a qualified issue names, not the working tree's", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const stdin = JSON.stringify({ issue: "Other/Repo#4", body: "x" })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], stdin))).toEqual(answer(ADD_ID, ["other/repo"]))
  })

  test("lists every repository the call writes to", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const stdin = JSON.stringify({ issue: "4", parent: "Other/Repo#2" })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], stdin))).toEqual(
      answer(ADD_ID, ["octo/hello", "other/repo"]),
    )
  })

  test("is * when the repository cannot be resolved", async () => {
    const repo = tempRepo()
    cleanups.push(repo.cleanup)
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir]))).toEqual(answer(ADD_ID, ["*"]))
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], '{"repo":"not a repo"}'))).toEqual(
      answer(ADD_ID, ["*"]),
    )
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], '{"repo":3}'))).toEqual(answer(ADD_ID, ["*"]))
  })

  test("is * for a bare number in the install directory, and still names a qualified issue there", async () => {
    const repo = tempRepo("git@github.com:Octo/Self.git")
    cleanups.push(repo.cleanup)
    const argv = ["target", ADD_ID, "--cwd", repo.dir]
    expect(json(await cli(argv, '{"issue":"3"}', { ownDir: repo.dir }))).toEqual(answer(ADD_ID, ["*"]))
    expect(json(await cli(argv, '{"issue":"o/r#3"}', { ownDir: repo.dir }))).toEqual(answer(ADD_ID, ["o/r"]))
    expect(json(await cli(argv, '{"issue":"3"}'))).toEqual(answer(ADD_ID, ["octo/self"]))
  })

  test("an unknown tool is invalid_argument", async () => {
    const run = await cli(["target", "github_nonexistent_read", "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })
})

describe("target in a language", () => {
  const ARGS = '{"repo":"Octo/Hello"}'
  const ENGLISH = {
    resources: ["octo/hello"],
    title: DESCRIBED_ID,
    words: ENGLISH_WORDS,
    description: {
      headline: 'Label the repository "Octo/Hello"',
      facts: [{ label: "Repository", value: "Octo/Hello" }],
      text: { label: "Body", body: "Body<U+202E> line\nnext" },
    },
    pin: expect.stringMatching(PIN_PATTERN),
  }
  const JAPANESE = {
    resources: ["octo/hello"],
    title: "ラベル付け",
    words: JAPANESE_WORDS,
    description: {
      headline: 'リポジトリ "Octo/Hello" にラベルを付ける',
      facts: [{ label: "リポジトリ", value: "Octo/Hello" }],
      text: { label: "本文", body: "Body<U+202E> line\nnext" },
    },
    pin: expect.stringMatching(PIN_PATTERN),
  }

  /** Runs `target` for the described fixture with the fixture translations, over `flags` and `env`. */
  const target = (flags: string[], env: Record<string, string | undefined> = {}) =>
    cli(["target", DESCRIBED_ID, "--cwd", "/x", ...flags], ARGS, { env, translations: TRANSLATIONS })

  test("--language translates the title, the plugin's words and the description's words", async () => {
    const run = await target(["--language", "ja"])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual(JAPANESE)
  })

  test("takes the --flag=value form and a regional tag", async () => {
    expect(json(await target(["--language=ja-JP"]))).toEqual(JAPANESE)
    expect(json(await target(["--harness-language=ja_JP"]))).toEqual(JAPANESE)
  })

  test("--harness-language alone translates", async () => {
    expect(json(await target(["--harness-language", "ja"]))).toEqual(JAPANESE)
  })

  test("--language wins over --harness-language, and a language without a table is English", async () => {
    expect(json(await target(["--language", "en", "--harness-language", "ja"]))).toEqual(ENGLISH)
    expect(json(await target(["--language", "ja", "--harness-language", "fr"]))).toEqual(JAPANESE)
  })

  test("the environment variable sits between the flag and the harness language", async () => {
    expect(json(await target(["--harness-language", "fr"], { GITHUB_TOOLS_LANGUAGE: "ja" }))).toEqual(JAPANESE)
    expect(json(await target(["--harness-language", "ja"], { GITHUB_TOOLS_LANGUAGE: "fr" }))).toEqual(ENGLISH)
    expect(json(await target(["--language", "fr"], { GITHUB_TOOLS_LANGUAGE: "ja" }))).toEqual(ENGLISH)
  })

  test("blank values count as unset", async () => {
    expect(json(await target(["--harness-language", "ja"], { GITHUB_TOOLS_LANGUAGE: "  " }))).toEqual(JAPANESE)
  })

  test("an unknown language, and none, keep English", async () => {
    expect(json(await target(["--language", "fr"]))).toEqual(ENGLISH)
    expect(json(await target([]))).toEqual(ENGLISH)
  })

  test("without package translations the plugin's own words are still translated", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x", "--language", "ja"], ARGS)
    expect(json(run)).toEqual({ resources: ["octo/hello"], title: `Title of ${ADD_ID}`, words: JAPANESE_WORDS })
  })

  test("the flags may come before --cwd", async () => {
    const run = await cli(["target", DESCRIBED_ID, "--language", "ja", "--cwd", "/x"], ARGS, {
      translations: TRANSLATIONS,
    })
    expect(json(run)).toEqual(JAPANESE)
  })
})

describe("list with an intent", () => {
  test("carries the intent of the tools that have one, and no key for the others", async () => {
    const run = await cli(["list", "--tools", INTENT_ID], "", { specs: [...specs, ...intentSpecs] })
    expect(run.code).toBe(EXIT_OK)
    const listed: { id: string; intent?: string }[] = json(run)
    const intents = Object.fromEntries(listed.map((entry) => [entry.id, entry.intent]))
    expect(intents[INTENT_ID]).toBe(INTENT)
    expect(listed.filter((entry) => "intent" in entry).map((entry) => entry.id)).toEqual([INTENT_ID])
  })
})

describe("target with an intent", () => {
  const target = (id: string, flags: string[]) =>
    cli(["target", id, "--cwd", "/x", ...flags], '{"repo":"Octo/Hello"}', {
      specs: [...specs, ...intentSpecs],
      translations: INTENT_TRANSLATIONS,
    })

  test("answers the intent beside the title, in English", async () => {
    const run = await target(INTENT_ID, [])
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual({ resources: ["octo/hello"], title: INTENT_ID, intent: INTENT, words: ENGLISH_WORDS })
  })

  test("translates the intent", async () => {
    const reply = json(await target(INTENT_ID, ["--language", "ja"]))
    expect(reply.intent).toBe("イシューに触れようとしています")
    expect(reply.title).toBe(INTENT_ID)
  })

  test("leaves the intent out for a tool without one", async () => {
    expect("intent" in json(await target(ADD_ID, ["--language", "ja"]))).toBe(false)
  })
})

describe("pin", () => {
  const STAMP_ID = "github_issue_stamp"
  const OTHER_PIN = "0".repeat(64)
  const ARGS = '{"repo":"Octo/Hello"}'

  /** What the stamp fixture describes now, and how often it ran. */
  const state = { value: "a", runs: 0 }

  const stamp: ToolSpec = defineTool({
    id: STAMP_ID,
    title: STAMP_ID,
    description: STAMP_ID,
    toolset: "issues",
    class: "add",
    input,
    output: z.object({ runs: z.number() }),
    targets: { repo: "repo" },
    describe: () => ({ facts: [{ label: "Value", value: state.value }] }),
    async execute() {
      return { runs: ++state.runs }
    },
  })

  beforeEach(() => {
    state.value = "a"
    state.runs = 0
  })

  /** The command line over the fixture specs and the stamp fixture. */
  const run = (argv: string[], stdin = ARGS) => cli(argv, stdin, { specs: [...specs, stamp] })

  /** `target` for the stamp fixture, then `change`, then `run` with the pin it gave and `extra` flags. */
  async function targetThenRun(change: () => void, extra: string[] = []) {
    const pin = json(await run(["target", STAMP_ID, "--cwd", "/x"])).pin as string
    change()
    return run(["run", STAMP_ID, "--cwd", "/x", "--pin", pin, ...extra])
  }

  describe("target pin", () => {
    test("gives a pin of 64 hex digits for a described call", async () => {
      const answer = json(await run(["target", STAMP_ID, "--cwd", "/x"]))
      expect(answer.pin).toMatch(PIN_PATTERN)
    })

    test("gives none for a tool without a describer", async () => {
      const answer = json(await run(["target", ADD_ID, "--cwd", "/x"]))
      expect("pin" in answer).toBe(false)
    })

    test("gives the same pin in another language, and another pin for another state", async () => {
      const argv = ["target", DESCRIBED_ID, "--cwd", "/x"]
      const english = json(await cli(argv, ARGS, { translations: TRANSLATIONS }))
      const japanese = json(await cli([...argv, "--language", "ja"], ARGS, { translations: TRANSLATIONS }))
      const other = json(await cli(argv, '{"repo":"Octo/World"}', { translations: TRANSLATIONS }))
      expect(japanese.pin).toBe(english.pin)
      expect(other.pin).not.toBe(english.pin)
    })
  })

  describe("run --pin", () => {
    test("runs the call when what the pin covered is unchanged", async () => {
      const result = await targetThenRun(() => {})
      expect(result).toEqual({ code: EXIT_OK, stdout: '{"result":{"runs":1}}\n', stderr: "" })
    })

    test("takes the --pin=<hex> form", async () => {
      const pin = json(await run(["target", STAMP_ID, "--cwd", "/x"])).pin as string
      const result = await run(["run", STAMP_ID, "--cwd", "/x", `--pin=${pin}`])
      expect(result.code).toBe(EXIT_OK)
    })

    test("writes stale and does not run when the described state changed", async () => {
      const result = await targetThenRun(() => (state.value = "b"))
      expect(result.code).toBe(EXIT_FAILED)
      expect(result.stderr).toBe("")
      expect(json(result).error.code).toBe("stale")
      expect(state.runs).toBe(0)
    })

    test("writes stale for a pin of another call", async () => {
      const result = await run(["run", STAMP_ID, "--cwd", "/x", "--pin", OTHER_PIN])
      expect(result.code).toBe(EXIT_FAILED)
      expect(json(result).error.code).toBe("stale")
      expect(state.runs).toBe(0)
    })

    test("writes stale for a pin on a tool that does not describe", async () => {
      const result = await cli(["run", ADD_ID, "--cwd", "/x", "--pin", OTHER_PIN], ARGS)
      expect(result.code).toBe(EXIT_FAILED)
      expect(json(result).error.code).toBe("stale")
    })

    test("takes the pin before the selection flags", async () => {
      const result = await targetThenRun(() => {}, ["--tools", ADD_ID])
      expect(result.code).toBe(EXIT_OK)
    })

    test.each([["abc"], ["A".repeat(64)], ["g".repeat(64)], [OTHER_PIN + "0"]])("rejects the pin %j", async (pin) => {
      for (const flags of [["--pin", pin], [`--pin=${pin}`]]) {
        const result = await run(["run", STAMP_ID, "--cwd", "/x", ...flags])
        expect(result.code).toBe(EXIT_USAGE)
        expect(result.stdout).toBe("")
        expect(result.stderr).toStartWith(`${PROJECT.cli}: Option --pin needs`)
      }
      expect(state.runs).toBe(0)
    })

    test("rejects --pin without a value", async () => {
      for (const flags of [["--pin"], ["--pin="]]) {
        const result = await run(["run", STAMP_ID, "--cwd", "/x", ...flags])
        expect(result).toEqual({
          code: EXIT_USAGE,
          stdout: "",
          stderr: `${PROJECT.cli}: Option --pin needs a value.\n`,
        })
      }
    })

    test("without --pin runs as before, even after the state changed", async () => {
      state.value = "b"
      const result = await run(["run", STAMP_ID, "--cwd", "/x"])
      expect(result.code).toBe(EXIT_OK)
      expect(json(result)).toEqual({ result: { runs: 1 } })
    })

    test("target does not take --pin", async () => {
      const result = await run(["target", STAMP_ID, "--cwd", "/x", "--pin", OTHER_PIN])
      expect(result.code).toBe(EXIT_USAGE)
      expect(result.stderr).toContain('Unknown option "--pin".')
    })
  })
})

describe("target flags", () => {
  test.each([["--language"], ["--harness-language"]])("%s without a value is a usage error", async (flag) => {
    for (const flags of [[flag], [flag, "--cwd", "/x"], [`${flag}=`]]) {
      const run = await cli(["target", ADD_ID, "--cwd", "/x", ...flags])
      expect(run).toEqual({
        code: EXIT_USAGE,
        stdout: "",
        stderr: `${PROJECT.cli}: Option ${flag} needs a value.\n`,
      })
    }
  })

  test("any other leftover is still an unknown option", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x", "--language", "ja", "--bogus"])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('Unknown option "--bogus".')
  })

  test.each([["--language"], ["--harness-language"]])("list and run reject %s", async (flag) => {
    const cases: [string[], string][] = [
      [["list", flag, "ja"], flag],
      [["run", ADD_ID, "--cwd", "/x", flag, "ja"], flag],
      [["run", ADD_ID, "--cwd", "/x", `${flag}=ja`], `${flag}=ja`],
    ]
    for (const [argv, option] of cases) {
      const run = await cli(argv)
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stdout).toBe("")
      expect(run.stderr).toContain(`Unknown option "${option}".`)
    }
  })
})

describe("usage", () => {
  test.each([
    [[], "No command given"],
    [["bogus"], 'Unknown command "bogus"'],
    [["list", "--confirm", "harness"], "--confirm"],
    [["list", "--confirm=elicitation"], "--confirm"],
    [["list", "--nope"], "--nope"],
    [["list", "--toolsets", "bogus"], "bogus"],
    [["list", "--tools", "github_nonexistent_read"], "github_nonexistent_read"],
    [["list", ADD_ID], ADD_ID],
    [["run"], "needs a tool id"],
    [["run", "--cwd", "/x"], "needs a tool id"],
    [["run", ADD_ID], "--cwd"],
    [["run", ADD_ID, "--cwd"], "--cwd"],
    [["run", ADD_ID, "--cwd", "--read-only"], "--cwd"],
    [["run", ADD_ID, "--cwd="], "--cwd"],
    [["run", ADD_ID, "--cwd", "/x", "--confirm", "harness"], "--confirm"],
    [["target", ADD_ID], "--cwd"],
    [["target", ADD_ID, "--cwd", "/x", "--read-only"], "--read-only"],
  ])("%j is one line on stderr, exit 2 and nothing on stdout", async (argv, message) => {
    const run = await cli(argv as string[])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe("")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(run.stderr).toContain(message)
  })

  test("ignores GITHUB_TOOLS_CONFIRM", async () => {
    expect((await cli(["list"], "", { env: { GITHUB_TOOLS_CONFIRM: "ask" } })).code).toBe(EXIT_OK)
  })
})
