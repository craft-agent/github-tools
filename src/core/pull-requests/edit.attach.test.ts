import { describe, expect, test } from "bun:test"
import { MP4_BYTES, PNG_BYTES, attachmentFiles, copiesGone } from "../../testing/attachment-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { prCommands, prEditedRule, prWrites, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prEdit } from "./edit"

const { use, run } = writeHarness(prEdit)
const files = attachmentFiles()

const EDIT = ["pr", "edit", "7", "--repo", "octo/hello"]
const URL = "https://github.com/octo/hello/pull/7"
const PARTIAL: GhRule = {
  match: "^pr edit",
  stdout: `${URL}\n`,
  stderr: "failed to upload shot.png: HTTP 500",
  code: 1,
}
const FAILED: GhRule = { match: "^pr edit", stderr: "HTTP 404: Not Found", code: 1 }

/** The rules every call needs, after the ones a test adds: write permission and an edit that prints pull request 7's URL. */
const base = (...rules: GhRule[]): GhRule[] => [...rules, repositoryRule(), prEditedRule(7)]

describe("attachments", () => {
  test("alone they are a change: no body flag is sent, and the files are attached", async () => {
    const shot = await files.write("shot.png")
    const installed = use(base())
    const result = await run({ pr: "7", attachments: [{ path: shot, alt: "The error" }] })

    const [first] = installed.attached()
    expect(prCommands(installed)).toEqual([{ args: [...EDIT, "--attach", `${first!.file}#The error`], stdin: "" }])
    expect(first!.file).toMatch(/github-tools-attach-[^/]+\/0\/shot\.png$/)
    expect(first!.content).toEqual(PNG_BYTES)
    expect(result).toEqual({
      repo: "octo/hello",
      pr: 7,
      url: URL,
      changed: ["attachments"],
      milestone: null,
      attachments: [{ path: shot, kind: "image", bytes: PNG_BYTES.length, alt: "The error" }],
      notes: [],
      foreign: false,
      errors: {},
    })
  })

  test("with a body: the references in it point at the copies, and the other flags keep their order", async () => {
    const shot = await files.write("shot.png")
    const demo = await files.write("demo.mp4", MP4_BYTES)
    const installed = use(base())
    const result = await run({
      pr: "7",
      title: "T",
      body: `![x](${shot})\n<video src="${demo}"></video>`,
      add_labels: ["a"],
      attachments: [{ path: shot }, { path: demo }],
    })

    const [first, second] = installed.attached()
    expect(prCommands(installed)).toEqual([
      {
        args: [
          ...EDIT,
          "--title",
          "T",
          "--body-file",
          "-",
          "--add-label",
          "a",
          "--attach",
          first!.file,
          "--attach",
          second!.file,
        ],
        stdin: `![x](${first!.file})\n<video src="${second!.file}"></video>`,
      },
    ])
    expect(result.changed).toEqual(["title", "body", "add_labels", "attachments"])
  })

  test("with append_body, the text added is rewritten with the rest of the body", async () => {
    const shot = await files.write("shot.png")
    const installed = use(base(stateRule({ body: "Intro" })))
    await run({ pr: "7", append_body: `![x](${shot})`, attachments: [{ path: shot }] })
    const [first] = installed.attached()
    expect(prCommands(installed).at(-1)!.stdin).toBe(`Intro\n\n![x](${first!.file})`)
  })

  test("a video over 10 MiB is noted", async () => {
    const demo = await files.writeLargeVideo("demo.mp4")
    use(base())
    const result = await run({ pr: "7", attachments: [{ path: demo }] })
    expect(result.notes).toEqual([`${demo} is over 10 MiB; uploading a video that large may need a paid GitHub plan.`])
  })

  test("a gh older than 2.99 is gh_too_old, and nothing is written", async () => {
    const shot = await files.write("shot.png")
    const installed = use(base(), { version: "2.98.0" })
    const error = await failure(run({ pr: "7", title: "T", attachments: [{ path: shot }] }))
    expect(error.code).toBe("gh_too_old")
    expect(error.message).toContain("attachments needs gh 2.99.0 or newer")
    expect(prWrites(installed)).toEqual([])
  })

  test("an older gh still edits when nothing is attached", async () => {
    use(base(), { version: "2.94.0" })
    expect((await run({ pr: "7", title: "T", attachments: [] })).changed).toEqual(["title"])
  })

  test("a bad file is invalid_argument, naming it, and nothing is written", async () => {
    const empty = await files.write("empty.png", Buffer.alloc(0))
    const installed = use(base())
    const error = await failure(run({ pr: "7", title: "T", attachments: [{ path: empty }] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${empty} is empty`)
    expect(prWrites(installed)).toEqual([])
    expect(installed.attached()).toEqual([])
  })

  test("a partial upload still edits: the result carries errors.attachments", async () => {
    const shot = await files.write("shot.png")
    use(base(PARTIAL))
    const result = await run({ pr: "7", title: "T", attachments: [{ path: shot }] })
    expect(result.url).toBe(URL)
    expect(result.changed).toEqual(["title", "attachments"])
    expect(result.errors).toEqual({
      attachments: "github_error: gh failed (exit 1): failed to upload shot.png: HTTP 500",
    })
  })

  test("a failure that printed no URL is thrown", async () => {
    const shot = await files.write("shot.png")
    use(base(FAILED))
    expect((await failure(run({ pr: "7", attachments: [{ path: shot }] }))).code).toBe("not_found")
  })

  test.each([
    ["a success", prEditedRule(7)],
    ["a partial upload", PARTIAL],
    ["a failure", FAILED],
  ])("the copies are removed after %s", async (_name, rule) => {
    const shot = await files.write("shot.png")
    const installed = use(base(rule))
    await run({ pr: "7", attachments: [{ path: shot }] }).catch(() => undefined)
    expect(installed.attached()).toHaveLength(1)
    expect(copiesGone(installed)).toBe(true)
  })
})
