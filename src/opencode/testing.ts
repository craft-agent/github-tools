import { z } from "zod"
import { ToolError, defineTool, type ToolSpec, type Toolset, type Translations, type WriteClass } from "../core"

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

function fixture(id: string, toolset: Toolset, writeClass: WriteClass, events: string[]): ToolSpec {
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
