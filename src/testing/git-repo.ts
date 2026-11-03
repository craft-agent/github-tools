import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type TempRepo = { dir: string; cleanup(): void }

/** A throwaway repository on `main`, cut off from the user's and the system's git config. */
export function tempRepo(origin?: string): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-repo-")))
  const globalConfig = join(root, "gitconfig")
  writeFileSync(globalConfig, "")
  const dir = join(root, "repo")
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" })

  git(root, "init", "-q", "-b", "main", dir)
  if (origin !== undefined) git(dir, "remote", "add", "origin", origin)
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
