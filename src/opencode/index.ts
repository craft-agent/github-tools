import { ALL_TOOLS } from "../tools"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"
import type { OpenCodePlugin } from "./types"

const PLUGIN_ID = "agent-github"

/** The skills sit in the package root, one level above the built `dist/opencode.js`. */
const SKILLS_DIR = new URL("../skills/", import.meta.url)

/** The OpenCode plugin: V2 reads `id` and `setup`, V1 reads `server`. */
const plugin: OpenCodePlugin = {
  id: PLUGIN_ID,
  setup: createV2Setup(ALL_TOOLS, { skillsDir: SKILLS_DIR }),
  server: createV1Server(ALL_TOOLS),
}

export default plugin
