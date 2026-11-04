import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { exec, isAbortError, isWithin, passthroughEnv } from "../core"

const FILE_URI_PROTOCOL = "file:"

/** Whether a directory is inside a git work tree; a missing directory or a missing `git` is a no. */
async function isInsideWorkTree(dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: dir, env: passthroughEnv(), signal })
    return result.code === 0
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    return false
  }
}

/** The directory a root URI names, or `undefined` for anything but an existing local directory. */
function localDirectory(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    if (url.protocol !== FILE_URI_PROTOCOL) return undefined
    const dir = fileURLToPath(url)
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

/** The first root of the client that is a local directory inside a git work tree, and not inside `ownDir`. */
async function firstGitRoot(server: Server, ownDir?: string, signal?: AbortSignal): Promise<string | undefined> {
  const { roots } = await server.listRoots(undefined, { signal })
  for (const root of roots) {
    const dir = localDirectory(root.uri)
    if (dir === undefined || (ownDir !== undefined && (await isWithin(dir, ownDir)))) continue
    if (await isInsideWorkTree(dir, signal)) return dir
  }
  return undefined
}

/**
 * Resolves the directory a call runs in: the first of the client's roots that
 * is inside a git work tree (the root itself, not the work tree's top) and not
 * inside `ownDir`, else `fallback()`. A client that advertises no roots always
 * gets `fallback()`. The answer is kept until the client reports that its
 * roots changed.
 */
export function createWorkingDirResolver(
  server: Server,
  fallback: () => string,
  ownDir?: string,
): (signal?: AbortSignal) => Promise<string> {
  let cached: string | undefined
  let generation = 0
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    cached = undefined
    generation++
  })

  return async (signal) => {
    if (!server.getClientCapabilities()?.roots) return fallback()
    if (cached !== undefined) return cached
    const started = generation
    let dir: string
    try {
      dir = (await firstGitRoot(server, ownDir, signal)) ?? fallback()
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      return fallback()
    }
    if (generation === started) cached = dir
    return dir
  }
}
