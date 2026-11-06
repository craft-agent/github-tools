import { afterEach, beforeEach } from "bun:test"
import type { z } from "zod"
import { resetIssueTypeCache } from "../core/github/repository"
import { invoke, type ToolSpec } from "../core/tool"
import { installFakeGh, type FakeGh, type GhRule } from "./fake-gh"
import { tempRepo, type TempRepo } from "./git-repo"
import { ORIGIN } from "./write-fixtures"

/**
 * Sets up each test of a file that tests one write tool: a temporary working
 * tree whose origin is `octo/hello` on GitHub, a fresh Issue Type cache, and
 * the fake `gh`, which `use` installs and the file's `afterEach` removes.
 */
export function writeHarness<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(spec: ToolSpec<I, O>) {
  let repo: TempRepo
  let fake: FakeGh | undefined

  beforeEach(() => {
    repo = tempRepo(ORIGIN)
    resetIssueTypeCache()
  })

  afterEach(() => {
    fake?.restore()
    fake = undefined
    repo.cleanup()
  })

  return {
    use(rules: GhRule[], options?: { version?: string }): FakeGh {
      fake = installFakeGh(rules, options)
      return fake
    },
    run: (args: Record<string, unknown>) => invoke(spec, args, { cwd: repo.dir }),
  }
}
