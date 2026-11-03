import type { ToolSpec } from "./core"
import { issueCreate } from "./core/issues/create"
import { issueRead } from "./core/issues/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [issueRead, issueCreate]
