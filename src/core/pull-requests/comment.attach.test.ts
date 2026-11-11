import { describe, expect, test } from "bun:test"
import { MP4_BYTES, PNG_BYTES, attachmentFiles, copiesGone } from "../../testing/attachment-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { prCommands } from "../../testing/pull-request-write-fixtures"
import { repositoryRule, sent, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prComment } from "./comment"

const { use, run } = writeHarness(prComment)
const files = attachmentFiles()

const URL = "https://github.com/octo/hello/pull/12#issuecomment-99"
const COMMENT = ["pr", "comment", "12", "--repo", "octo/hello", "--body-file", "-"]
const COMMENTED: GhRule = { match: "^pr comment", stdout: `${URL}\n` }
const PARTIAL: GhRule = {
  match: "^pr comment",
  stdout: `${URL}\n`,
  stderr: "failed to upload shot.png: HTTP 500",
  code: 1,
}

describe("attachments", () => {
  test("become --attach flags after the body flag; the body's references point at the copies", async () => {
    const shot = await files.write("shot.png")
    const demo = await files.write("demo.mp4", MP4_BYTES)
    const installed = use([repositoryRule(), COMMENTED])
    const result = await run({
      pr: "12",
      body: `Before:\n![the error](${shot})`,
      attachments: [{ path: shot, alt: "The error" }, { path: demo }],
    })

    const [{ args, stdin }] = prCommands(installed)
    const [first, second] = installed.attached()
    expect(args).toEqual([...COMMENT, "--attach", `${first!.file}#The error`, "--attach", second!.file])
    expect(first!.file).toMatch(/github-tools-attach-[^/]+\/0\/shot\.png$/)
    expect(second!.file).toMatch(/github-tools-attach-[^/]+\/1\/demo\.mp4$/)
    expect(stdin).toBe(`Before:\n![the error](${first!.file})`)
    // The copies existed while gh ran, with the files' bytes.
    expect(first!.content).toEqual(PNG_BYTES)
    expect(second!.content).toEqual(MP4_BYTES)
    expect(result).toEqual({
      repo: "octo/hello",
      pr: 12,
      url: URL,
      attachments: [
        { path: shot, kind: "image", bytes: PNG_BYTES.length, alt: "The error" },
        { path: demo, kind: "video", bytes: MP4_BYTES.length, alt: null },
      ],
      notes: [],
      foreign: false,
      errors: {},
    })
  })

  test("a video over 10 MiB is noted", async () => {
    const demo = await files.writeLargeVideo("demo.mp4")
    use([repositoryRule(), COMMENTED])
    const result = await run({ pr: "12", body: "Hi", attachments: [{ path: demo }] })
    expect(result.notes).toEqual([`${demo} is over 10 MiB; uploading a video that large may need a paid GitHub plan.`])
  })

  test("a gh older than 2.99 is gh_too_old, and nothing is written", async () => {
    const shot = await files.write("shot.png")
    const installed = use([repositoryRule(), COMMENTED], { version: "2.98.0" })
    const error = await failure(run({ pr: "12", body: "Hi", attachments: [{ path: shot }] }))
    expect(error.code).toBe("gh_too_old")
    expect(error.message).toBe("attachments needs gh 2.99.0 or newer; this is gh 2.98.0. Update the GitHub CLI.")
    expect(writes(installed)).toEqual([])
  })

  test("an older gh still comments when nothing is attached", async () => {
    use([repositoryRule(), COMMENTED], { version: "2.94.0" })
    expect((await run({ pr: "12", body: "Hi", attachments: [] })).url).toBe(URL)
  })

  test("a bad file is invalid_argument, naming it, and nothing is written", async () => {
    const shot = await files.write("shot.png")
    const fake = await files.write("fake.png", Buffer.from("not an image"))
    const installed = use([repositoryRule(), COMMENTED])
    const error = await failure(run({ pr: "12", body: "Hi", attachments: [{ path: shot }, { path: fake }] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${fake} does not look like a png file`)
    expect(writes(installed)).toEqual([])
    expect(installed.attached()).toEqual([])
  })

  test("a partial upload still posts the comment: its URL comes back with errors.attachments", async () => {
    const shot = await files.write("shot.png")
    use([repositoryRule(), PARTIAL])
    const result = await run({ pr: "12", body: "Hi", attachments: [{ path: shot }] })
    expect(result.url).toBe(URL)
    expect(result.attachments).toHaveLength(1)
    expect(result.errors).toEqual({
      attachments: "upstream_error: gh failed (exit 1): failed to upload shot.png: HTTP 500",
    })
  })

  test("a failure that printed no URL is thrown", async () => {
    const shot = await files.write("shot.png")
    use([repositoryRule(), { match: "^pr comment", stderr: "HTTP 404: Not Found", code: 1 }])
    expect((await failure(run({ pr: "12", body: "Hi", attachments: [{ path: shot }] }))).code).toBe("not_found")
  })

  test.each([
    ["a success", COMMENTED],
    ["a partial upload", PARTIAL],
    ["a failure", { match: "^pr comment", stderr: "HTTP 404: Not Found", code: 1 }],
  ])("the copies are removed after %s", async (_name, rule) => {
    const shot = await files.write("shot.png")
    const installed = use([repositoryRule(), rule])
    await run({ pr: "12", body: "Hi", attachments: [{ path: shot }] }).catch(() => undefined)
    expect(installed.attached()).toHaveLength(1)
    expect(copiesGone(installed)).toBe(true)
  })

  test("more than 50 attachments are refused before any call", async () => {
    const installed = use([repositoryRule(), COMMENTED])
    const attachments = Array.from({ length: 51 }, () => ({ path: "shot.png" }))
    expect((await failure(run({ pr: "12", body: "Hi", attachments }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
