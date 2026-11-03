import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { tempRepo } from "../testing/git-repo"
import type { ServerOptions } from "./server"
import { call, cleanups, connect, runCleanups, settings, settle, tool, type Call, type ClientSetup } from "./testing"

afterEach(runCleanups)

describe("working directory", () => {
  const roots = { roots: { listChanged: true } }

  function repo() {
    const made = tempRepo()
    cleanups.push(made.cleanup)
    return made.dir
  }

  function plainDir() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plain-dir-")))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  async function setup(client: ClientSetup, options?: ServerOptions) {
    const calls: Call[] = []
    const connected = await connect([tool("github_issue_read", "issues", "read", calls)], settings(), client, options)
    const cwd = async () => {
      await call(connected.client, "github_issue_read")
      return calls.at(-1)!.ctx.cwd
    }
    return { ...connected, cwd }
  }

  test("a root inside a git work tree is the working directory", async () => {
    const dir = repo()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [dir] } })
    expect(await cwd()).toBe(dir)
  })

  test("the root itself is used, not the top of its work tree", async () => {
    const top = repo()
    const nested = join(top, "src")
    mkdirSync(nested)
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [nested] } })
    expect(await cwd()).toBe(nested)
  })

  test("a root that is not a git work tree is skipped for the first one that is", async () => {
    const plain = plainDir()
    const git = repo()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [plain, join(plain, "missing"), git] } })
    expect(await cwd()).toBe(git)
  })

  test("a root on another host is skipped, and the search goes on", async () => {
    const plain = plainDir()
    const git = repo()
    const { cwd } = await setup(
      { capabilities: roots, roots: { dirs: ["file://remote-host/x", plain, git] } },
      { cwd: () => "/fallback" },
    )
    expect(await cwd()).toBe(git)
  })

  test("a file URI naming a missing directory is skipped, and the search goes on", async () => {
    const git = repo()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [pathToFileURL("/no/such/dir").href, git] } })
    expect(await cwd()).toBe(git)
  })

  test("only bad roots fall back to the fallback directory", async () => {
    const { cwd } = await setup(
      { capabilities: roots, roots: { dirs: ["file://remote-host/x", pathToFileURL("/no/such/dir").href] } },
      { cwd: () => "/fallback" },
    )
    expect(await cwd()).toBe("/fallback")
  })

  test("with no git root among the roots, the fallback directory is used", async () => {
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [plainDir()] } }, { cwd: () => "/fallback" })
    expect(await cwd()).toBe("/fallback")
  })

  test("a client that advertises no roots gets options.cwd()", async () => {
    const { cwd, seen } = await setup({}, { cwd: () => "/from/options" })
    expect(await cwd()).toBe("/from/options")
    expect(seen.rootsRequests).toBe(0)
  })

  test("without options.cwd the process directory is the fallback", async () => {
    const { cwd } = await setup({})
    expect(await cwd()).toBe(process.cwd())
  })

  test("the answer is cached until the client reports its roots changed", async () => {
    const first = repo()
    const second = repo()
    const client = { capabilities: roots, roots: { dirs: [first] } }
    const { client: mcpClient, cwd, seen } = await setup(client)

    expect(await cwd()).toBe(first)
    expect(await cwd()).toBe(first)
    expect(seen.rootsRequests).toBe(1)

    client.roots.dirs = [second]
    expect(await cwd()).toBe(first)
    expect(seen.rootsRequests).toBe(1)

    await mcpClient.sendRootsListChanged()
    await settle()
    expect(await cwd()).toBe(second)
    expect(seen.rootsRequests).toBe(2)
  })
})
