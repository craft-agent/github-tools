import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resetGhCheck } from "../core/gh"

const DEFAULT_VERSION = "2.102.0"
const SCRIPT_SOURCE = fileURLToPath(new URL("./gh-script.mjs", import.meta.url))

/**
 * One canned reply. The first rule whose `match` (a regular expression tested
 * against the arguments joined by spaces) fits answers; `times` limits how
 * many calls it answers, so a later rule can answer the next ones, and
 * `delayMs` holds the answer back, for tests of time limits and cancellation.
 */
export type GhRule = {
  match: string
  stdout?: string
  stderr?: string
  code?: number
  times?: number
  delayMs?: number
  /** Ends the fake with this signal instead of answering. */
  killSelf?: NodeJS.Signals
}

export type FakeGh = {
  dir: string
  /** The arguments of every call so far, oldest first. */
  calls(): string[][]
  /** What each call in `calls()` received on stdin; empty for a call that was given none. */
  stdins(): string[]
  /** The files named by `--attach` as each call saw them: the path, the alt text, and the content, or `null` when the file was not there. */
  attached(): { file: string; alt: string | null; content: Buffer | null }[]
  /** Puts `PATH` back, removes the fake and forgets the version check. */
  restore(): void
}

/**
 * Puts a fake `gh` first on `PATH`. It answers `--version` itself unless a rule
 * matches first, answers `__env` with the variables a call received, and exits
 * 1 for a call no rule matches. Call `restore()` when the test ends.
 */
export function installFakeGh(rules: GhRule[], options: { version?: string } = {}): FakeGh {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-gh-")))
  const script = join(dir, "gh")
  copyFileSync(SCRIPT_SOURCE, script)
  chmodSync(script, 0o755)
  // The script has no extension, so a package.json makes Node read it as a module.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ rules, version: options.version ?? DEFAULT_VERSION }))
  writeFileSync(join(dir, "calls.log"), "")
  writeFileSync(join(dir, "stdin.log"), "")

  const originalPath = process.env.PATH
  process.env.PATH = originalPath === undefined ? dir : `${dir}${delimiter}${originalPath}`
  resetGhCheck()

  return {
    dir,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    stdins: () =>
      readFileSync(join(dir, "stdin.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string),
    attached() {
      const log = join(dir, "attached.log")
      if (!existsSync(log)) return []
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { file: string; alt: string | null; content: string | null }
          return { ...entry, content: entry.content === null ? null : Buffer.from(entry.content, "base64") }
        })
    },
    restore() {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
      resetGhCheck()
    },
  }
}
