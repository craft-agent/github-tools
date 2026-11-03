import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isToolError } from "./errors"
import { parseRepo } from "./refs"

const savedHost = process.env.GH_HOST

beforeEach(() => {
  delete process.env.GH_HOST
})

afterEach(() => {
  if (savedHost === undefined) delete process.env.GH_HOST
  else process.env.GH_HOST = savedHost
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
