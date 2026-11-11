import { describe, expect, test } from "bun:test"
import { MP4_BYTES, PNG_BYTES, attachmentFiles, copiesGone } from "../../testing/attachment-fixtures"
import { HEAD_SHA, branchRule, defaultBranchRule } from "../../testing/develop-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { prCommands, prCreatedRule, prEditedRule, prWrites, stateRule } from "../../testing/pull-request-write-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { prCreate } from "./create"

const { use, run } = writeHarness(prCreate)
const files = attachmentFiles()

const CREATE = ["pr", "create", "--repo", "octo/hello", "--base", "main", "--head", "feature"]
const URL = "https://github.com/octo/hello/pull/7"
const UPLOAD_FAILURE = "failed to upload shot.png: HTTP 500"
const PARTIAL: GhRule = { match: "^pr create", stdout: `${URL}\n`, stderr: UPLOAD_FAILURE, code: 1 }
const FOUND = JSON.stringify([{ number: 47, url: "https://github.com/octo/hello/pull/47" }])

/** The rules of a call that finds both branches, no pull request open yet and the default branch `main`. */
const base = (...rules: GhRule[]): GhRule[] => [
  ...rules,
  repositoryRule(),
  defaultBranchRule("main"),
  branchRule("octo/hello", "main", true),
  branchRule("octo/hello", "feature", true),
  { match: "^pr list", stdout: "[]" },
  prCreatedRule(7),
  prEditedRule(7),
  stateRule(),
]

const createOf = (installed: Parameters<typeof prCommands>[0]) =>
  prCommands(installed).find((call) => call.args[1] === "create")!

describe("attachments", () => {
  test("become --attach flags after the other create flags; the body's references point at the copies", async () => {
    const shot = await files.write("shot.png")
    const demo = await files.write("demo.mp4", MP4_BYTES)
    const installed = use(base())
    const result = await run({
      head: "feature",
      title: "T",
      body: `Fixes the crash.\n\n![before](${shot})`,
      draft: true,
      attachments: [{ path: shot, alt: "Before" }, { path: demo }],
    })

    const [first, second] = installed.attached()
    expect(createOf(installed)).toEqual({
      args: [
        ...CREATE,
        "--title",
        "T",
        "--body-file",
        "-",
        "--draft",
        "--attach",
        `${first!.file}#Before`,
        "--attach",
        second!.file,
      ],
      stdin: `Fixes the crash.\n\n![before](${first!.file})`,
    })
    expect(first!.file).toMatch(/github-tools-attach-[^/]+\/0\/shot\.png$/)
    expect(second!.file).toMatch(/github-tools-attach-[^/]+\/1\/demo\.mp4$/)
    expect(first!.content).toEqual(PNG_BYTES)
    expect(second!.content).toEqual(MP4_BYTES)
    expect(result.attachments).toEqual([
      { path: shot, kind: "image", bytes: PNG_BYTES.length, alt: "Before" },
      { path: demo, kind: "video", bytes: MP4_BYTES.length, alt: null },
    ])
    expect(result.errors).toEqual({})
    expect(result.pr.number).toBe(7)
  })

  test("a video over 10 MiB is noted", async () => {
    const demo = await files.writeLargeVideo("demo.mp4")
    use(base())
    const result = await run({ head: "feature", title: "T", attachments: [{ path: demo }] })
    expect(result.notes).toEqual([`${demo} is over 10 MiB; uploading a video that large may need a paid GitHub plan.`])
  })

  test("a gh older than 2.99 is gh_too_old, and nothing is created", async () => {
    const shot = await files.write("shot.png")
    const installed = use(base(), { version: "2.98.0" })
    const error = await failure(run({ head: "feature", title: "T", attachments: [{ path: shot }] }))
    expect(error.code).toBe("gh_too_old")
    expect(error.message).toContain("attachments needs gh 2.99.0 or newer")
    expect(prWrites(installed)).toEqual([])
  })

  test("an older gh still creates when nothing is attached", async () => {
    use(base(), { version: "2.94.0" })
    expect((await run({ head: "feature", title: "T", attachments: [] })).pr.number).toBe(7)
  })

  test("a bad file is invalid_argument, naming it, and nothing is created", async () => {
    const fake = await files.write("fake.png", Buffer.from("not an image"))
    const installed = use(base())
    const error = await failure(run({ head: "feature", title: "T", attachments: [{ path: fake }] }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${fake} does not look like a png file`)
    expect(prWrites(installed)).toEqual([])
    expect(installed.attached()).toEqual([])
  })

  test("a partial upload still made the pull request: it is returned with errors.attachments, and the steps go on", async () => {
    const shot = await files.write("shot.png")
    const installed = use(base(PARTIAL))
    const result = await run({ head: "feature", title: "T", labels: ["feature"], attachments: [{ path: shot }] })
    expect(result.pr).toEqual({ number: 7, url: URL, title: "T" })
    expect(result.head_sha).toBe(HEAD_SHA)
    expect(result.errors).toEqual({ attachments: `upstream_error: gh failed (exit 1): ${UPLOAD_FAILURE}` })
    expect(result.attachments).toHaveLength(1)
    expect(prCommands(installed).map((call) => call.args[1])).toEqual(["list", "create", "edit"])
  })

  test("a failure that printed no URL is looked up like any other: the pull request found is returned", async () => {
    const shot = await files.write("shot.png")
    const outage = "pull request update failed: Something went wrong."
    use(
      base(
        { match: "^pr create", stderr: outage, code: 1 },
        { match: "^pr list", stdout: "[]", times: 1 },
        { match: "^pr list", stdout: FOUND },
      ),
    )
    const result = await run({ head: "feature", title: "T", attachments: [{ path: shot }] })
    expect(result.pr.number).toBe(47)
    expect(result.errors).toEqual({ create: `upstream_error: gh failed (exit 1): ${outage}` })
  })

  test("a refusal that made nothing is thrown", async () => {
    const shot = await files.write("shot.png")
    use(base({ match: "^pr create", stderr: "HTTP 403: Resource not accessible by integration", code: 1 }))
    expect((await failure(run({ head: "feature", title: "T", attachments: [{ path: shot }] }))).code).toBe("forbidden")
  })

  test.each([
    ["a success", prCreatedRule(7)],
    ["a partial upload", PARTIAL],
    ["a refusal", { match: "^pr create", stderr: "HTTP 403: Resource not accessible by integration", code: 1 }],
  ])("the copies are removed after %s", async (_name, rule) => {
    const shot = await files.write("shot.png")
    const installed = use(base(rule))
    await run({ head: "feature", title: "T", attachments: [{ path: shot }] }).catch(() => undefined)
    expect(installed.attached()).toHaveLength(1)
    expect(copiesGone(installed)).toBe(true)
  })
})
