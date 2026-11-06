import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { failure } from "../testing/issue-fixtures"
import { prepareAttachments, type AttachmentArgument, type Prepared } from "./attachments"

const MIB = 1024 * 1024

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image data")])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("image data")])
const GIF = Buffer.from("GIF89a image data")
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 data")])
const SVG = Buffer.from('\uFEFF<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from("video data")])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("video data")])

let dir: string
let prepared: Prepared | undefined

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "attachments-test-")))
})

afterEach(async () => {
  await prepared?.cleanup()
  prepared = undefined
  await rm(dir, { recursive: true, force: true })
})

async function put(name: string, content: Buffer): Promise<string> {
  const path = join(dir, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

async function prepare(...items: AttachmentArgument[]): Promise<Prepared> {
  prepared = await prepareAttachments(items, { cwd: dir })
  return prepared
}

/** The message of the invalid_argument a preparation fails with. */
async function refusal(...items: AttachmentArgument[]): Promise<string> {
  const error = await failure(prepareAttachments(items, { cwd: dir }))
  expect(error.code).toBe("invalid_argument")
  return error.message
}

const copyOf = (flags: string[], index = 0): string => flags[index * 2 + 1]!.split("#")[0]!

describe("what is accepted", () => {
  test.each([
    ["shot.png", PNG, "image"],
    ["shot.jpg", JPEG, "image"],
    ["shot.JPEG", JPEG, "image"],
    ["anim.gif", GIF, "image"],
    ["shot.webp", WEBP, "image"],
    ["logo.svg", SVG, "image"],
    ["demo.mp4", MP4, "video"],
    ["demo.mov", MP4, "video"],
    ["demo.webm", WEBM, "video"],
  ] as const)("%s is a %s", async (name, content, kind) => {
    const path = await put(name, content)
    const result = await prepare({ path })
    expect(result.files).toEqual([{ path, real_path: path, kind, bytes: content.length, alt: null }])
    expect(result.notes).toEqual([])
  })

  test("a GIF87a is a gif too", async () => {
    const path = await put("old.gif", Buffer.from("GIF87a image data"))
    expect((await prepare({ path })).files[0]!.kind).toBe("image")
  })

  test("no attachments prepare nothing: no flags, no directory, the body untouched", async () => {
    const before = await readdir(tmpdir())
    for (const items of [undefined, []]) {
      const none = await prepareAttachments(items, { cwd: dir })
      expect(none.flags).toEqual([])
      expect(none.files).toEqual([])
      expect(none.rewriteBody("![a](./a.png)")).toBe("![a](./a.png)")
      await none.cleanup()
    }
    expect((await readdir(tmpdir())).filter((name) => !before.includes(name))).toEqual([])
  })
})

describe("paths", () => {
  test("a relative path is resolved against the working directory, a ~ path against the home directory", async () => {
    const relative = await put("sub/shot.png", PNG)
    expect((await prepare({ path: "sub/shot.png" })).files[0]!.real_path).toBe(relative)
    // The afterEach hook cleans up only the last preparation.
    await prepared?.cleanup()

    const underHome = await mkdtemp(join(homedir(), ".attachments-test-"))
    try {
      await writeFile(join(underHome, "shot.png"), PNG)
      const file = (await prepare({ path: `~/${basename(underHome)}/shot.png` })).files[0]!
      expect(file.real_path).toBe(await realpath(join(underHome, "shot.png")))
    } finally {
      await rm(underHome, { recursive: true, force: true })
    }
  })

  test("a link is followed: real_path is the file, path stays as given", async () => {
    const target = await put("real.png", PNG)
    await symlink(target, join(dir, "latest.png"))
    const file = (await prepare({ path: "latest.png" })).files[0]!
    expect(file.path).toBe("latest.png")
    expect(file.real_path).toBe(target)
  })
})

describe("the private copy", () => {
  test("each file is copied under its own name in its own directory of one private directory", async () => {
    const first = await put("a/shot.png", PNG)
    const second = await put("b/shot.png", Buffer.concat([PNG, Buffer.from("other")]))
    const result = await prepare({ path: first }, { path: second })
    const copies = [copyOf(result.flags, 0), copyOf(result.flags, 1)]
    expect(copies.map((copy) => basename(copy))).toEqual(["shot.png", "shot.png"])
    expect(copies.map((copy) => basename(dirname(copy)))).toEqual(["0", "1"])
    expect(new Set(copies.map((copy) => dirname(dirname(copy)))).size).toBe(1)
    expect(basename(dirname(dirname(copies[0]!)))).toStartWith("github-tools-attach-")
    expect(readFileSync(copies[0]!)).toEqual(PNG)
  })

  test("the copy holds the source's bytes", async () => {
    const content = Buffer.concat([PNG, Buffer.alloc(3 * MIB + 17, 7)])
    const path = await put("big.png", content)
    const result = await prepare({ path })
    expect(readFileSync(copyOf(result.flags))).toEqual(content)
    expect(result.files[0]!.bytes).toBe(content.length)
  })

  test("cleanup removes the directory, and may be called twice", async () => {
    const path = await put("shot.png", PNG)
    const result = await prepare({ path })
    const root = dirname(dirname(copyOf(result.flags)))
    expect(existsSync(root)).toBe(true)
    await result.cleanup()
    expect(existsSync(root)).toBe(false)
    await result.cleanup()
  })

  test("a refusal removes what it had copied", async () => {
    const good = await put("good.png", PNG)
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("github-tools-attach-"))
    await refusal({ path: good }, { path: join(dir, "missing.png") })
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("github-tools-attach-"))
    expect(after).toEqual(before)
  })
})

describe("flags", () => {
  test("an image with alt text is <copy>#<alt>; without, the bare copy; a blank alt is none", async () => {
    const png = await put("a.png", PNG)
    const jpg = await put("b.jpg", JPEG)
    const gif = await put("c.gif", GIF)
    const result = await prepare({ path: png, alt: " The login error " }, { path: jpg }, { path: gif, alt: "  " })
    expect(result.flags.filter((flag) => flag === "--attach")).toHaveLength(3)
    expect(result.flags[1]).toBe(`${copyOf(result.flags, 0)}#The login error`)
    expect(result.flags[3]).toBe(copyOf(result.flags, 1))
    expect(result.flags[5]).toBe(copyOf(result.flags, 2))
    expect(result.files.map((file) => file.alt)).toEqual(["The login error", null, null])
  })

  test("a video with a blank alt is accepted", async () => {
    const path = await put("demo.mp4", MP4)
    expect((await prepare({ path, alt: " " })).files[0]!.alt).toBeNull()
  })
})

describe("refusals", () => {
  test("a missing file", async () => {
    expect(await refusal({ path: "nope.png" })).toContain("nope.png does not exist")
  })

  test("a directory, even one named like an image", async () => {
    await mkdir(join(dir, "dir.png"))
    expect(await refusal({ path: "dir.png" })).toContain("dir.png is a directory")
  })

  test("an empty file", async () => {
    const path = await put("empty.png", Buffer.alloc(0))
    expect(await refusal({ path })).toContain("is empty")
  })

  test("a blank path", async () => {
    expect(await refusal({ path: "  " })).toContain("has no path")
  })

  test("an extension gh does not attach", async () => {
    const path = await put("notes.txt", Buffer.from("text"))
    expect(await refusal({ path })).toContain("notes.txt is not a type gh attaches")
    expect(await refusal({ path: join(dir, "noextension") })).toContain("is not a type gh attaches")
  })

  test.each([
    ["shot.png", JPEG],
    ["shot.jpg", PNG],
    ["shot.gif", PNG],
    ["shot.webp", Buffer.from("RIFF....WAVE")],
    ["shot.svg", PNG],
    ["demo.mp4", PNG],
    ["demo.mov", WEBM],
    ["demo.webm", MP4],
    ["short.png", Buffer.from([0x89, 0x50])],
  ])("%s with the wrong content does not look like its extension", async (name, content) => {
    const path = await put(name, content)
    expect(await refusal({ path })).toContain(`does not look like a ${name.split(".")[1]} file`)
  })

  test("an svg whose tag is past the first 4 KiB", async () => {
    const path = await put("late.svg", Buffer.concat([Buffer.alloc(4096, " "), Buffer.from("<svg></svg>")]))
    expect(await refusal({ path })).toContain("does not look like a svg file")
  })

  test("an image over 10 MiB, a video over 100 MiB", async () => {
    const image = await put("huge.png", PNG)
    await truncate(image, 10 * MIB + 1)
    expect(await refusal({ path: image })).toContain("images can be at most 10 MiB")
    const video = await put("huge.mp4", MP4)
    await truncate(video, 100 * MIB + 1)
    expect(await refusal({ path: video })).toContain("videos can be at most 100 MiB")
  })

  test("a '#' in the path or in the alt text", async () => {
    const path = await put("a#b.png", PNG)
    expect(await refusal({ path })).toContain("contains '#'")
    const plain = await put("plain.png", PNG)
    expect(await refusal({ path: plain, alt: "issue #4" })).toContain("alt text containing '#'")
  })

  test("alt text on a video", async () => {
    const path = await put("demo.webm", WEBM)
    expect(await refusal({ path, alt: "The demo" })).toContain("is a video, which has no alt text")
  })

  test("the same file twice, also through a link", async () => {
    const path = await put("shot.png", PNG)
    await symlink(path, join(dir, "same.png"))
    const message = await refusal({ path }, { path: "same.png" })
    expect(message).toContain("same.png is attached twice")
    expect(await refusal({ path }, { path })).toContain("is attached twice")
  })

  test("every message names the file", async () => {
    const path = await put("shot.png", JPEG)
    expect(await refusal({ path })).toStartWith(`attachments: ${path} `)
  })
})

describe("large videos", () => {
  test("a video over 10 MiB gets a note, one at the limit does not", async () => {
    const large = await put("large.mp4", MP4)
    await truncate(large, 10 * MIB + 1)
    const small = await put("small.mp4", MP4)
    await truncate(small, 10 * MIB)
    const result = await prepare({ path: large }, { path: small })
    expect(result.notes).toEqual([`${large} is over 10 MiB; uploading a video that large may need a paid GitHub plan.`])
  })
})

describe("rewriteBody", () => {
  test("points every reference, written as given or as the absolute path, at the copy", async () => {
    const path = await put("screens/shot.png", PNG)
    await put("other.png", PNG)
    const result = await prepare({ path: "screens/shot.png" }, { path: "other.png", alt: "x" })
    const [copy, otherCopy] = [copyOf(result.flags, 0), copyOf(result.flags, 1)]
    const body = [
      "![a](screens/shot.png)",
      "![b](./screens/shot.png)",
      '![c](screens/shot.png "A title")',
      `![d](<${path}> 'Another')`,
      '<img src="screens/shot.png" width="10">',
      `<img src='${path}'>`,
      "![e](other.png)",
    ].join("\n")
    expect(result.rewriteBody(body)).toBe(
      [
        `![a](${copy})`,
        `![b](${copy})`,
        `![c](${copy} "A title")`,
        `![d](<${copy}> 'Another')`,
        `<img src="${copy}" width="10">`,
        `<img src='${copy}'>`,
        `![e](${otherCopy})`,
      ].join("\n"),
    )
  })

  test("nothing else changes: plain text, longer names, other targets, other attributes", async () => {
    await put("shot.png", PNG)
    const result = await prepare({ path: "shot.png" })
    const body = [
      "See shot.png and ./shot.png in the text.",
      "[older](./shot.png.bak) ![x](./a/shot.png) ![y](shot.png#frag)",
      '<img data-src="shot.png"> <a href="shot.png">link</a>',
      "`![code](./shot.png)` is still a link as far as we can tell",
      "Closes #12",
      "",
    ].join("\n")
    const rewritten = result.rewriteBody(body)
    const copy = copyOf(result.flags)
    expect(rewritten).toBe(body.replace("`![code](./shot.png)`", `\`![code](${copy})\``))
  })

  test("replacement patterns in the body are literal, and a body without references is returned as it is", async () => {
    await put("shot.png", PNG)
    const result = await prepare({ path: "shot.png" })
    const copy = copyOf(result.flags)
    expect(result.rewriteBody("a $& b $1 ![a](shot.png)")).toBe(`a $& b $1 ![a](${copy})`)
    expect(result.rewriteBody("")).toBe("")
  })
})
