import { z } from "zod"
import { ToolError, defineTool, type ToolSpec, type Translations, type WriteClass } from "../core"

/** Fixtures the OpenCode plugin tests share. */

export const toolInput = z.object({
  repo: z.string().describe("The repository, as owner/name.").optional(),
  count: z.number().int().describe("How many.").optional(),
})
export const toolOutput = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})

/** What a write fixture takes beyond a read one: an issue, and a second repository it may write to. */
const writeInput = toolInput.extend({ issue: z.string().optional(), branch_repo: z.string().optional() })
const WRITE_TARGETS = { issue: "issue", repo: "repo", branch_repo: "repo" } as const

export const READ_ID = "github_issue_read"
export const ADD_ID = "github_issue_comment"
export const LABEL_ID = "github_issue_label"
export const ADMIN_ID = "github_release_publish"
export const FAILING_ID = "github_issue_close"

/** Japanese words for the add fixture's title and for the label fixture's headline, fact label and text label. */
export const TRANSLATIONS: Translations = {
  ja: {
    [`Title of ${ADD_ID}`]: "追加ツール",
    "Label the repository {repo}": "リポジトリ {repo} にラベルを付ける",
    Repository: "リポジトリ",
    Body: "本文",
  },
}

/** The approval prompts of the add and label fixtures for `Octo/Hello`, in English and through `TRANSLATIONS`. */
export const ENGLISH_ADD = `Title of ${ADD_ID}\n\n--- Details ---\n\nTarget: octo/hello`
export const JAPANESE_ADD = "追加ツール\n\n--- 詳細 ---\n\n対象: octo/hello"
export const ENGLISH_LABEL =
  'Label the repository "Octo/Hello"\n\n--- Details ---\n\nTarget: octo/hello\nRepository: Octo/Hello\n\n--- Body ---\n\nBody<U+202E>'
export const JAPANESE_LABEL =
  'リポジトリ "Octo/Hello" にラベルを付ける\n\n--- 詳細 ---\n\n対象: octo/hello\nリポジトリ: Octo/Hello\n\n--- 本文 ---\n\nBody<U+202E>'

function fixture(id: string, toolset: string, writeClass: WriteClass, events: string[]): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(writeClass === "read" ? {} : { targets: WRITE_TARGETS }),
    input: writeClass === "read" ? toolInput : writeInput,
    output: toolOutput,
    async execute(args, ctx) {
      events.push(`execute:${id}`)
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

/**
 * A read and two add tools of `issues`, an administrative tool of `releases`, and
 * an `issues` tool that fails with `not_found`; `events` logs each execution.
 */
export function fixtureSpecs(events: string[]): ToolSpec[] {
  return [
    fixture(READ_ID, "issues", "read", events),
    fixture(ADD_ID, "issues", "add", events),
    defineTool({
      ...fixture(LABEL_ID, "issues", "add", events),
      describe: (args) => ({
        headline: { text: "Label the repository {repo}", values: { repo: String(args.repo ?? "here") } },
        facts: [{ label: "Repository", value: String(args.repo ?? "here") }],
        text: { label: "Body", body: "Body\u202E" },
      }),
    }),
    fixture(ADMIN_ID, "releases", "administrative", events),
    defineTool({
      id: FAILING_ID,
      title: FAILING_ID,
      description: FAILING_ID,
      toolset: "issues",
      class: "overwrite",
      input: toolInput,
      output: toolOutput,
      async execute() {
        throw new ToolError("not_found", "No such issue.")
      },
    }),
  ]
}

export const INTENT_ID = "github_issue_touch"
export const INTENT_LABEL_ID = "github_issue_mark"
export const INTENT = "About to touch the issue"

/** Japanese words for the intent fixtures' intent and headline. */
export const INTENT_TRANSLATIONS: Translations = {
  ja: {
    [INTENT]: "イシューに触れようとしています",
    "Mark the repository {repo}": "リポジトリ {repo} に印を付けようとしています",
  },
}

/** The approval prompts of the intent fixtures for `Octo/Hello`: the intent stands for the headline, or the headline stands. */
export const ENGLISH_INTENT = `${INTENT}\n\n--- Details ---\n\nTarget: octo/hello`
export const JAPANESE_INTENT = "イシューに触れようとしています\n\n--- 詳細 ---\n\n対象: octo/hello"
export const ENGLISH_INTENT_LABEL = 'Mark the repository "Octo/Hello"\n\n--- Details ---\n\nTarget: octo/hello'
export const JAPANESE_INTENT_LABEL =
  'リポジトリ "Octo/Hello" に印を付けようとしています\n\n--- 詳細 ---\n\n対象: octo/hello'

/** Two add tools of `issues` with an intent: one without `describe`, one with a headline. */
export function intentSpecs(events: string[]): ToolSpec[] {
  return [
    defineTool({ ...fixture(INTENT_ID, "issues", "add", events), intent: INTENT }),
    defineTool({
      ...fixture(INTENT_LABEL_ID, "issues", "add", events),
      intent: INTENT,
      describe: (args) => ({
        headline: { text: "Mark the repository {repo}", values: { repo: String(args.repo ?? "here") } },
        facts: [],
      }),
    }),
  ]
}

export const PIN_ID = "github_issue_stamp"

/** The failure a harness reports when the pin fixture's described state changed after the prompt. */
export const PIN_STALE = `stale: ${PIN_ID} did not run: what its approval showed changed before it could run. Call it again to be asked again.`

/** What the pin fixture describes now: a test changes it where the harness asks for approval. */
export type PinState = { value: string; failing?: boolean }

/** An add tool of `issues` whose describer reads `state`: a fact from its `value`, and a describer that throws while `failing`. */
export function pinSpecs(events: string[], state: PinState): ToolSpec[] {
  return [
    defineTool({
      ...fixture(PIN_ID, "issues", "add", events),
      describe: () => {
        if (state.failing) throw new Error("cannot tell")
        return { facts: [{ label: "Value", value: state.value }] }
      },
    }),
  ]
}
