import { afterEach, beforeEach } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FakeGh } from "./fake-gh"

/** Files to attach and a view of what a fake `gh` saw of them. */

export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("image data"),
])
export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from("video")])

const MIB = 1024 * 1024
/** A little over the size above which a video is noted as possibly needing a paid plan. */
const LARGE_VIDEO_BYTES = 10 * MIB + 1

/** Sets up a directory for the files of each test of a file, removed after it. */
export function attachmentFiles() {
  let dir: string

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "attach-files-")))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Writes a file and returns its absolute path. */
  async function write(name: string, content: Buffer = PNG_BYTES): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, content)
    return path
  }

  /** Writes a video of a little over 10 MiB, sparse so it costs nothing. */
  async function writeLargeVideo(name: string): Promise<string> {
    const path = await write(name, MP4_BYTES)
    await truncate(path, LARGE_VIDEO_BYTES)
    return path
  }

  return { write, writeLargeVideo }
}

/** The private directory the tool copied the files into, found from the first copy a call named. */
export function copyDirectory(installed: FakeGh): string {
  return dirname(dirname(installed.attached()[0]!.file))
}

/** Whether every file a call attached, and the private directory they were in, is gone. */
export const copiesGone = (installed: FakeGh): boolean =>
  installed.attached().every(({ file }) => !existsSync(file)) && !existsSync(copyDirectory(installed))
