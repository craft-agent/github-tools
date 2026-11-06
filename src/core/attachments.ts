import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, open, realpath, rm, stat, type FileHandle } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { ToolError } from "./errors"
import type { ToolContext } from "./tool"

/** What the pull request tools share to upload images and videos with `gh --attach`: checks, a private copy and the body rewrite. */

const MIB = 1024 * 1024
const MAX_ATTACHMENTS = 50
const MAX_IMAGE_BYTES = 10 * MIB
const MAX_VIDEO_BYTES = 100 * MIB
/** A video over this size is refused by GitHub on a free plan. */
const LARGE_VIDEO_BYTES = 10 * MIB
/** How much of a file is read to tell what it is; an SVG's `<svg` must start within it. */
const HEAD_BYTES = 4096
const COPY_CHUNK_BYTES = 1024 * 1024
const PRIVATE_DIRECTORY = 0o700
const COPY_PREFIX = "github-tools-attach-"
const BOM = "\uFEFF"

export type AttachmentKind = "image" | "video"

type Format = { kind: AttachmentKind; matches(head: Buffer): boolean }

/** Whether `head` holds `signature` at `offset`; a shorter head does not. */
const holds = (head: Buffer, signature: Buffer, offset = 0): boolean =>
  head.length >= offset + signature.length && head.subarray(offset, offset + signature.length).equals(signature)

const ascii = (text: string): Buffer => Buffer.from(text, "latin1")

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff])
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const GIF_SIGNATURES = [ascii("GIF87a"), ascii("GIF89a")]
const RIFF = ascii("RIFF")
const WEBP = ascii("WEBP")
const FTYP = ascii("ftyp")
const WEBP_OFFSET = 8
const FTYP_OFFSET = 4
const SVG_TAG = "<svg"

const MP4_LIKE: Format = { kind: "video", matches: (head) => holds(head, FTYP, FTYP_OFFSET) }

/** The file types `gh` attaches, by extension, each with the content its extension promises. */
const FORMATS: Readonly<Record<string, Format>> = {
  ".png": { kind: "image", matches: (head) => holds(head, PNG) },
  ".jpg": { kind: "image", matches: (head) => holds(head, JPEG) },
  ".jpeg": { kind: "image", matches: (head) => holds(head, JPEG) },
  ".gif": { kind: "image", matches: (head) => GIF_SIGNATURES.some((signature) => holds(head, signature)) },
  ".webp": { kind: "image", matches: (head) => holds(head, RIFF) && holds(head, WEBP, WEBP_OFFSET) },
  ".svg": { kind: "image", matches: (head) => head.toString("utf8").replace(BOM, "").includes(SVG_TAG) },
  ".mp4": MP4_LIKE,
  ".mov": MP4_LIKE,
  ".webm": { kind: "video", matches: (head) => holds(head, WEBM) },
}

const SIZE_LIMITS: Readonly<Record<AttachmentKind, number>> = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_BYTES }

/** For a tool description: what can be attached, how the body and the files meet, and where a failed upload is reported. */
export const ATTACHMENTS_NOTE = `Attachments are images (png, jpg, gif, webp, svg, up to ${MAX_IMAGE_BYTES / MIB} MiB) and videos (mp4, mov, webm, up to ${MAX_VIDEO_BYTES / MIB} MiB), up to ${MAX_ATTACHMENTS}, uploaded with the text: a body reference like \`![alt](./shot.png)\` becomes the uploaded file and the others are appended; they need gh 2.99 or newer, and a file that fails to upload is listed under errors.attachments while the rest goes through.`

export const attachmentsArgument = z
  .array(
    z.object({
      path: z.string().describe("The file: an absolute path, ~/…, or relative to the working directory."),
      alt: z.string().optional().describe("Alt text, for an image only."),
    }),
  )
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe("Images and videos to upload with the text.")

export type AttachmentArgument = NonNullable<z.output<typeof attachmentsArgument>>[number]

export const attachmentsResultSchema = z
  .array(
    z.object({
      path: z.string().describe("The path as it was given."),
      kind: z.enum(["image", "video"]),
      bytes: z.number().int(),
      alt: z.string().nullable(),
    }),
  )
  .describe("The files that were sent; [] when none were given.")

export type PreparedFile = {
  /** The path as it was given. */
  path: string
  /** The file it resolves to once links are followed. */
  real_path: string
  kind: AttachmentKind
  bytes: number
  alt: string | null
}

/** Attachments that passed every check, copied where `gh` reads them. */
export type Prepared = {
  /** The `--attach` flags to add to the `gh` command. */
  flags: string[]
  /** The body with references to the attached files pointed at their copies, so `gh` recognises them. */
  rewriteBody(body: string): string
  files: PreparedFile[]
  /** What to tell the caller about the files. */
  notes: string[]
  /** Removes the copies; safe to call more than once. */
  cleanup(): Promise<void>
}

const NONE: Prepared = {
  flags: [],
  rewriteBody: (body) => body,
  files: [],
  notes: [],
  cleanup: async () => {},
}

function refuse(path: string, reason: string): ToolError {
  return new ToolError("invalid_argument", `attachments: ${path} ${reason}.`)
}

function resolvePath(path: string, ctx: ToolContext): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? path : resolve(ctx.cwd, path)
}

async function realFile(path: string, resolved: string): Promise<string> {
  try {
    return await realpath(resolved)
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    throw refuse(path, missing ? "does not exist" : `cannot be read (${(error as Error).message})`)
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/** Copies what is left of `source` to a new file at `copy` (readable by this user only), hashing what it read. */
async function copyHashed(source: FileHandle, copy: string, limit: number): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256")
  const target = await open(copy, "wx", 0o600)
  let bytes = 0
  try {
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await source.read(chunk, 0, COPY_CHUNK_BYTES, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > limit) break
      const part = chunk.subarray(0, bytesRead)
      hash.update(part)
      await target.writeFile(part)
    }
  } finally {
    await target.close()
  }
  return { sha256: hash.digest("hex"), bytes }
}

const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`

type Copied = { copy: string; file: PreparedFile }

/** Checks one attachment and copies it into its own subdirectory of `root`, which keeps the file's name. */
async function prepareOne(
  item: AttachmentArgument,
  index: number,
  root: string,
  seen: Set<string>,
  ctx: ToolContext,
): Promise<Copied> {
  const path = item.path
  if (!path.trim()) throw refuse(JSON.stringify(path), "has no path")
  if (path.includes("#")) throw refuse(path, "contains '#', which gh reads as the start of the alt text")
  const alt = item.alt?.trim() || null
  if (alt?.includes("#")) throw refuse(path, "has alt text containing '#', which gh would split on")

  const format = FORMATS[extname(path).toLowerCase()]
  if (!format) {
    throw refuse(path, `is not a type gh attaches: use ${Object.keys(FORMATS).join(", ")}`)
  }
  if (alt !== null && format.kind === "video") throw refuse(path, "is a video, which has no alt text")

  const real = await realFile(path, resolvePath(path, ctx))
  if (seen.has(real)) throw refuse(path, `is attached twice (${real})`)
  seen.add(real)
  const info = await stat(real)
  if (info.isDirectory()) throw refuse(path, "is a directory")
  if (!info.isFile()) throw refuse(path, "is not a regular file")
  if (info.size === 0) throw refuse(path, "is empty")

  const source = await open(real, "r")
  try {
    const before = await source.stat()
    const limit = SIZE_LIMITS[format.kind]
    if (before.size > limit) {
      throw refuse(path, `is ${mib(before.size)}; ${format.kind}s can be at most ${limit / MIB} MiB`)
    }
    const head = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await source.read(head, 0, HEAD_BYTES, 0)
    if (!format.matches(head.subarray(0, bytesRead))) {
      throw refuse(path, `does not look like a ${extname(path).toLowerCase().slice(1)} file`)
    }

    const directory = join(root, String(index))
    await mkdir(directory, { mode: PRIVATE_DIRECTORY })
    const copy = join(directory, basename(path))
    if (copy.includes("#")) {
      throw refuse(path, `cannot be copied under ${tmpdir()}, whose path contains '#'; point TMPDIR elsewhere`)
    }
    const copied = await copyHashed(source, copy, limit)
    const after = await source.stat()
    if (
      copied.bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      copied.sha256 !== (await sha256Of(copy))
    ) {
      throw refuse(path, "changed while it was being read; try again once it is written")
    }
    return { copy, file: { path, real_path: real, kind: format.kind, bytes: copied.bytes, alt } }
  } finally {
    await source.close()
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const CURRENT_DIRECTORY = "./"

/** The ways a body may name a file: as the caller wrote the path, with or without a leading `./`, and as the absolute path. */
function references(path: string, resolved: string): string[] {
  const refs = new Set([path, resolved])
  if (!isAbsolute(path) && !path.startsWith("~")) {
    const bare = path.startsWith(CURRENT_DIRECTORY) ? path.slice(CURRENT_DIRECTORY.length) : path
    refs.add(bare)
    refs.add(`${CURRENT_DIRECTORY}${bare}`)
  }
  return [...refs]
}

/** A Markdown link target for `copy`: bare unless it holds a space or a parenthesis. */
const linkTarget = (copy: string): string => (/[\s()]/.test(copy) ? `<${copy}>` : copy)

/** Points `](ref)`, `](<ref> "title")` and `src="ref"` in `body` at `copy` for each way `refs` names it. */
function repoint(body: string, refs: readonly string[], copy: string): string {
  const named = refs.map(escapeRegExp).join("|")
  const title = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*`
  const link = new RegExp(String.raw`\]\((?:(<(?:${named})>)|(?:${named}))(${title})\)`, "g")
  const source = new RegExp(String.raw`((?<![\w:-])src\s*=\s*)(["'])(?:${named})\2`, "g")
  return body
    .replace(
      link,
      (_match, angled: string | undefined, rest: string) => `](${angled ? `<${copy}>` : linkTarget(copy)}${rest})`,
    )
    .replace(source, (_match, prefix: string, quote: string) => `${prefix}${quote}${copy}${quote}`)
}

/**
 * Checks every attachment before anything is written to GitHub and copies each
 * into a private directory, so `gh` reads a file that cannot change under it.
 * A file is refused (`invalid_argument`, naming it) when it is missing, no
 * regular file, empty, not the type its extension says, over its size limit
 * or given twice, when its path or alt text contains `#`, or when a video has
 * alt text. The caller runs `cleanup` when `gh` has returned; a refusal
 * cleans up after itself. No attachments yields an empty `Prepared`.
 */
export async function prepareAttachments(
  items: readonly AttachmentArgument[] | undefined,
  ctx: ToolContext,
): Promise<Prepared> {
  if (!items?.length) return NONE

  const root = await mkdtemp(join(tmpdir(), COPY_PREFIX))
  const cleanup = () => rm(root, { recursive: true, force: true })
  try {
    const flags: string[] = []
    const files: PreparedFile[] = []
    const notes: string[] = []
    const seen = new Set<string>()
    const rewrites: { refs: string[]; copy: string }[] = []
    for (const [index, item] of items.entries()) {
      const { copy, file } = await prepareOne(item, index, root, seen, ctx)
      flags.push("--attach", file.alt === null ? copy : `${copy}#${file.alt}`)
      files.push(file)
      rewrites.push({ refs: references(item.path, resolvePath(item.path, ctx)), copy })
      if (file.kind === "video" && file.bytes > LARGE_VIDEO_BYTES) {
        notes.push(
          `${item.path} is over ${LARGE_VIDEO_BYTES / MIB} MiB; uploading a video that large may need a paid GitHub plan.`,
        )
      }
    }
    return {
      flags,
      rewriteBody: (body) => rewrites.reduce((text, { refs, copy }) => repoint(text, refs, copy), body),
      files,
      notes,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** The files of `prepared` as a result lists them. */
export const sentAttachments = (prepared: Prepared): z.input<typeof attachmentsResultSchema> =>
  prepared.files.map(({ path, kind, bytes, alt }) => ({ path, kind, bytes, alt }))
