import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { isToolError } from "./errors"
import { parseNumberRef, parseRepo, repoFromOrigin, resolveRepo } from "./refs"

const repos: TempRepo[] = []
const scratchDirs: string[] = []

function repoWithOrigin(origin?: string): TempRepo {
  const repo = tempRepo(origin)
  repos.push(repo)
  return repo
}

const GIT_ENV_NAMES = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "PATH", "GH_HOST"] as const
const savedEnv = Object.fromEntries(GIT_ENV_NAMES.map((name) => [name, process.env[name]]))

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "refs-test-")))
  scratchDirs.push(dir)
  return dir
}

/** Gives the test a user git config of its own, so nothing depends on the machine's. */
function useGitConfig(content: string): void {
  const file = join(scratchDir(), "gitconfig")
  writeFileSync(file, content)
  process.env.GIT_CONFIG_GLOBAL = file
  process.env.GIT_CONFIG_NOSYSTEM = "1"
}

beforeEach(() => {
  delete process.env.GH_HOST
  useGitConfig("")
})

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const name of GIT_ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

async function invalidArgument(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  const error = await (typeof promise === "function" ? Promise.resolve().then(promise) : promise).then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!isToolError(error) || error.code !== "invalid_argument")
    throw new Error(`expected invalid_argument, got ${String(error)}`)
  return error.message
}

describe("parseRepo", () => {
  test.each([
    ["octo/hello", "octo/hello"],
    [" octo/hello ", "octo/hello"],
    ["octo-org/hello.world_2", "octo-org/hello.world_2"],
    ["octo_emu/hello", "octo_emu/hello"],
    ["https://github.com/octo_emu/hello", "octo_emu/hello"],
    ["https://github.com/octo/hello", "octo/hello"],
    ["https://github.com/octo/hello.git", "octo/hello"],
    ["https://github.com/octo/hello/issues/3", "octo/hello"],
    ["https://github.com/octo/hello/", "octo/hello"],
  ])("%s", (value, full) => {
    const repo = parseRepo(value)
    expect(repo.full).toBe(full)
    expect(`${repo.owner}/${repo.name}`).toBe(full)
  })

  test.each([
    "",
    "octo",
    "octo/",
    "/hello",
    "a/b/c",
    "octo/hel lo",
    "-octo/hello",
    "https://example.com/octo/hello",
    "https://github.com/octo",
    "http://github.com/octo/hello",
    "octo/..",
  ])("rejects %p", async (value) => {
    expect(await invalidArgument(() => parseRepo(value))).toContain("owner/name")
  })

  test("accepts the URL of the host named by GH_HOST", () => {
    process.env.GH_HOST = "git.example.com"
    expect(parseRepo("https://git.example.com/octo/hello").full).toBe("octo/hello")
  })
})

describe("repoFromOrigin", () => {
  test.each([
    ["https://github.com/octo/hello.git"],
    ["https://github.com/octo/hello"],
    ["https://user:token@github.com/octo/hello.git"],
    ["git@github.com:octo/hello.git"],
    ["git@github.com:octo/hello"],
    ["ssh://git@github.com/octo/hello.git"],
    ["ssh://git@github.com:22/octo/hello.git"],
    ["ssh://git@ssh.github.com:443/octo/hello.git"],
    ["git@ssh.github.com:octo/hello"],
    ["https://x-access-token:abc@github.com/octo/hello"],
  ])("%s", async (origin) => {
    const repo = repoWithOrigin(origin)
    expect((await repoFromOrigin(repo.dir)).full).toBe("octo/hello")
  })

  test("an owner with an underscore (Enterprise Managed User) is accepted", async () => {
    const repo = repoWithOrigin("git@github.com:octo_emu/hello.git")
    expect((await repoFromOrigin(repo.dir)).full).toBe("octo_emu/hello")
  })

  test("ssh.github.com stands for github.com only when GH_HOST is not set", async () => {
    process.env.GH_HOST = "git.example.com"
    const repo = repoWithOrigin("git@ssh.github.com:octo/hello")
    await invalidArgument(repoFromOrigin(repo.dir))
  })

  test.each([
    ["https://user:ghp_secret@gitlab.example/o/r", "gitlab.example"],
    ["ssh://deploy:ghp_secret@gitlab.example/o/r.git", "gitlab.example"],
    ["https://x-access-token:ghp_secret@gitlab.example/o/r?token=ghp_secret#ghp_secret", "gitlab.example"],
    ["ghp_secret@gitlab.example:o/r.git", "gitlab.example"],
    ["user:ghp_secret@gitlab.example:o/r.git", "gitlab.example"],
  ])("a remote that is not on GitHub is refused without echoing credentials: %s", async (origin, host) => {
    const repo = repoWithOrigin(origin)
    const message = await invalidArgument(repoFromOrigin(repo.dir))
    expect(message).not.toContain("ghp_secret")
    expect(message).toContain(host)
    expect(message).toContain("pass `repo` as owner/name")
  })

  test("a remote with credentials on GitHub with a bad path is refused without echoing them", async () => {
    const repo = repoWithOrigin("https://x-access-token:ghp_secret@github.com/o")
    const message = await invalidArgument(repoFromOrigin(repo.dir))
    expect(message).not.toContain("ghp_secret")
    expect(message).not.toContain("x-access-token")
  })

  test("a remote that parses as nothing is not echoed at all", async () => {
    const repo = repoWithOrigin("ghp_secret")
    const message = await invalidArgument(repoFromOrigin(repo.dir))
    expect(message).not.toContain("ghp_secret")
  })

  test("a parsed repository never carries credentials", async () => {
    const repo = repoWithOrigin("https://x-access-token:ghp_secret@github.com/octo/hello")
    expect(JSON.stringify(await repoFromOrigin(repo.dir))).not.toContain("ghp_secret")
  })

  test("the user's git config applies, so an insteadOf rule rewrites the remote", async () => {
    useGitConfig('[url "https://github.com/"]\n\tinsteadOf = gh:\n')
    const repo = repoWithOrigin("gh:octo/hello")
    expect((await repoFromOrigin(repo.dir)).full).toBe("octo/hello")
  })

  test("git gets the passthrough environment, the git config variables and no prompts, nothing else", async () => {
    const dir = scratchDir()
    const report = join(dir, "env-report")
    const fakeGit = join(dir, "git")
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nprintf '%s|%s|%s|%s|%s' "$GIT_TERMINAL_PROMPT" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM" "$SSH_AUTH_SOCK" "$REFS_TEST_UNLISTED" > ${JSON.stringify(report)}\necho https://github.com/octo/hello\n`,
    )
    chmodSync(fakeGit, 0o755)
    process.env.PATH = `${dir}:${savedEnv.PATH}`
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock"
    process.env.REFS_TEST_UNLISTED = "leaked"
    try {
      expect((await repoFromOrigin(process.cwd())).full).toBe("octo/hello")
    } finally {
      delete process.env.SSH_AUTH_SOCK
      delete process.env.REFS_TEST_UNLISTED
    }
    expect(readFileSync(report, "utf8")).toBe(`0|${process.env.GIT_CONFIG_GLOBAL}|1|/tmp/agent.sock|`)
  })

  test("a host other than github.com is refused, telling the caller to pass repo", async () => {
    const repo = repoWithOrigin("git@gitlab.com:octo/hello.git")
    expect(await invalidArgument(repoFromOrigin(repo.dir))).toContain("pass `repo` as owner/name")
  })

  test("the host named by GH_HOST is accepted", async () => {
    process.env.GH_HOST = "git.example.com"
    const repo = repoWithOrigin("git@git.example.com:octo/hello.git")
    expect((await repoFromOrigin(repo.dir)).full).toBe("octo/hello")
  })

  test("a repository without origin is refused", async () => {
    const repo = repoWithOrigin()
    expect(await invalidArgument(repoFromOrigin(repo.dir))).toContain("pass `repo` as owner/name")
  })

  test("a directory that is not a repository is refused", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "not-a-repo-")))
    scratchDirs.push(dir)
    expect(await invalidArgument(repoFromOrigin(dir))).toContain("pass `repo` as owner/name")
  })

  test("an origin path that is not owner/name is refused", async () => {
    const repo = repoWithOrigin("https://github.com/octo")
    await invalidArgument(repoFromOrigin(repo.dir))
  })
})

describe("resolveRepo", () => {
  test("an explicit repo wins over origin", async () => {
    const repo = repoWithOrigin("https://github.com/octo/hello.git")
    expect((await resolveRepo("other/thing", { cwd: repo.dir })).full).toBe("other/thing")
  })

  test("without a repo, origin decides", async () => {
    const repo = repoWithOrigin("https://github.com/octo/hello.git")
    expect((await resolveRepo(undefined, { cwd: repo.dir })).full).toBe("octo/hello")
    expect((await resolveRepo("", { cwd: repo.dir })).full).toBe("octo/hello")
  })

  test("an invalid explicit repo is refused", async () => {
    await invalidArgument(resolveRepo("nonsense", { cwd: process.cwd() }))
  })
})

describe("ownDir", () => {
  const INSTALLED = "is where these tools are installed, not a project"

  /** An install directory that is a git checkout of its own, with origin `octo/self`. */
  function installDir(): string {
    return repoWithOrigin("https://github.com/octo/self.git").dir
  }

  test("a bare number in the install directory or below it fails, saying why", async () => {
    const ownDir = installDir()
    const below = join(ownDir, "dist", "deeper")
    mkdirSync(below, { recursive: true })
    for (const cwd of [ownDir, below]) {
      const message = await invalidArgument(parseNumberRef("3", undefined, { cwd, ownDir }))
      expect(message).toContain(`Cannot tell which repository to use: ${cwd} ${INSTALLED}`)
      expect(message).toContain("pass `repo` as owner/name")
      expect(message).toContain("owner/repo#N")
      expect(await invalidArgument(resolveRepo(undefined, { cwd, ownDir }))).toContain(INSTALLED)
      expect(await invalidArgument(repoFromOrigin(cwd, undefined, ownDir))).toContain(INSTALLED)
    }
  })

  test("an explicit repo or a qualified reference still works there", async () => {
    const ownDir = installDir()
    const ctx = { cwd: ownDir, ownDir }
    expect((await resolveRepo("x/y", ctx)).full).toBe("x/y")
    expect((await parseNumberRef("3", "x/y", ctx)).repo.full).toBe("x/y")
    expect((await parseNumberRef("a/b#3", undefined, ctx)).repo.full).toBe("a/b")
  })

  test("another working tree resolves by its origin as before", async () => {
    const ownDir = installDir()
    const other = repoWithOrigin("https://github.com/octo/other.git").dir
    expect((await parseNumberRef("3", undefined, { cwd: other, ownDir })).repo.full).toBe("octo/other")
  })

  test("without ownDir the install directory resolves by its origin", async () => {
    const ownDir = installDir()
    expect((await parseNumberRef("3", undefined, { cwd: ownDir })).repo.full).toBe("octo/self")
  })

  test("a sibling whose name only starts like the install directory is not inside it", async () => {
    const ownDir = installDir()
    const sibling = `${ownDir}-sibling`
    mkdirSync(sibling)
    const message = await invalidArgument(parseNumberRef("3", undefined, { cwd: sibling, ownDir }))
    expect(message).not.toContain(INSTALLED)
    expect(message).toContain("`origin`")
  })

  test("a path that is not there is not the install directory", async () => {
    const dir = installDir()
    const missing = join(dir, "missing")
    expect((await parseNumberRef("3", undefined, { cwd: dir, ownDir: missing })).repo.full).toBe("octo/self")
    expect(await invalidArgument(parseNumberRef("3", undefined, { cwd: missing, ownDir: dir }))).not.toContain(
      INSTALLED,
    )
  })

  test("paths compare by real path, through a symlink on either side", async () => {
    const ownDir = installDir()
    const below = join(ownDir, "sub")
    mkdirSync(below)
    const links = scratchDir()
    const toBelow = join(links, "to-below")
    const toOwn = join(links, "to-own")
    symlinkSync(below, toBelow)
    symlinkSync(ownDir, toOwn)
    expect(await invalidArgument(parseNumberRef("3", undefined, { cwd: toBelow, ownDir }))).toContain(INSTALLED)
    expect(await invalidArgument(parseNumberRef("3", undefined, { cwd: below, ownDir: toOwn }))).toContain(INSTALLED)
    expect(await invalidArgument(parseNumberRef("3", undefined, { cwd: toOwn, ownDir: toOwn }))).toContain(INSTALLED)
  })
})

describe("parseNumberRef", () => {
  const origin = "https://github.com/octo/hello.git"

  test.each(["12", "#12", " 12 "])("a bare number %p uses origin", async (ref) => {
    const repo = repoWithOrigin(origin)
    const parsed = await parseNumberRef(ref, undefined, { cwd: repo.dir })
    expect(parsed.number).toBe(12)
    expect(parsed.repo.full).toBe("octo/hello")
  })

  test("a bare number uses the repo argument over origin", async () => {
    const repo = repoWithOrigin(origin)
    const parsed = await parseNumberRef("12", "other/thing", { cwd: repo.dir })
    expect(parsed.repo.full).toBe("other/thing")
  })

  test("a bare number with neither repo nor origin fails saying so", async () => {
    const repo = repoWithOrigin()
    expect(await invalidArgument(parseNumberRef("12", undefined, { cwd: repo.dir }))).toContain(
      "pass `repo` as owner/name",
    )
  })

  test("owner/repo#12 names its own repository", async () => {
    const parsed = await parseNumberRef("octo/hello#12", undefined, { cwd: process.cwd() })
    expect(parsed).toEqual({ repo: { owner: "octo", name: "hello", full: "octo/hello" }, number: 12 })
  })

  test.each([
    "https://github.com/octo/hello/issues/12",
    "https://github.com/octo/hello/pull/12",
    "https://github.com/octo/hello/pull/12/files",
    "https://github.com/octo/hello/issues/12#issuecomment-1",
    "https://github.com/octo/hello/issues/12?foo=bar",
  ])("the URL %s", async (ref) => {
    const parsed = await parseNumberRef(ref, undefined, { cwd: process.cwd() })
    expect(parsed.repo.full).toBe("octo/hello")
    expect(parsed.number).toBe(12)
  })

  test("a reference that names its repository accepts the same repo argument, in any case", async () => {
    const parsed = await parseNumberRef("octo/hello#12", "Octo/Hello", { cwd: process.cwd() })
    expect(parsed.number).toBe(12)
  })

  describe("accept", () => {
    const ISSUE_URL = "https://github.com/octo/hello/issues/12"
    const PULL_URL = "https://github.com/octo/hello/pull/12"
    const ctx = { cwd: process.cwd() }

    test("issue refuses a pull request URL and says so", async () => {
      const message = await invalidArgument(parseNumberRef(PULL_URL, undefined, ctx, { accept: "issue" }))
      expect(message).toContain(PULL_URL)
      expect(message).toContain("is a pull request, not an issue")
    })

    test("pull refuses an issue URL and says so", async () => {
      const message = await invalidArgument(parseNumberRef(ISSUE_URL, undefined, ctx, { accept: "pull" }))
      expect(message).toContain("is an issue, not a pull request")
    })

    test("each kind accepts its own URL", async () => {
      expect((await parseNumberRef(ISSUE_URL, undefined, ctx, { accept: "issue" })).number).toBe(12)
      expect((await parseNumberRef(PULL_URL, undefined, ctx, { accept: "pull" })).number).toBe(12)
    })

    test("any, and no option, accept both URLs", async () => {
      for (const options of [{ accept: "any" as const }, undefined]) {
        expect((await parseNumberRef(ISSUE_URL, undefined, ctx, options)).number).toBe(12)
        expect((await parseNumberRef(PULL_URL, undefined, ctx, options)).number).toBe(12)
      }
    })

    test.each(["issue", "pull"] as const)("the forms that do not say which kind pass for %s", async (accept) => {
      const repo = repoWithOrigin(origin)
      expect((await parseNumberRef("12", undefined, { cwd: repo.dir }, { accept })).number).toBe(12)
      expect((await parseNumberRef("octo/hello#12", undefined, ctx, { accept })).number).toBe(12)
    })

    test("the kind is checked before the repository conflict", async () => {
      const message = await invalidArgument(parseNumberRef(PULL_URL, "other/thing", ctx, { accept: "issue" }))
      expect(message).toContain("pull request")
    })
  })

  test("a reference and a repo argument that name different repositories conflict", async () => {
    const message = await invalidArgument(parseNumberRef("octo/hello#12", "other/thing", { cwd: process.cwd() }))
    expect(message).toContain("octo/hello")
    expect(message).toContain("other/thing")
    await invalidArgument(
      parseNumberRef("https://github.com/octo/hello/issues/12", "other/thing", { cwd: process.cwd() }),
    )
  })

  test.each([
    "",
    "abc",
    "0",
    "#",
    "12abc",
    "-3",
    "octo/hello",
    "https://github.com/octo/hello",
    "https://github.com/octo/hello/issues/x",
    "https://github.com/octo/hello/actions/runs/12",
    "https://example.com/octo/hello/issues/12",
    "99999999999999999999",
  ])("rejects %p", async (ref) => {
    await invalidArgument(parseNumberRef(ref, undefined, { cwd: process.cwd() }))
  })
})
