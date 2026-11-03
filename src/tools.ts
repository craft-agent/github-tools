import type { ToolSpec } from "./core"
import { issueClose } from "./core/issues/close"
import { issueComment } from "./core/issues/comment"
import { issueCreate } from "./core/issues/create"
import { issueEdit } from "./core/issues/edit"
import { issueRead } from "./core/issues/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [issueRead, issueCreate, issueEdit, issueComment, issueClose]
