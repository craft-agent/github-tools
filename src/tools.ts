import type { ToolSpec } from "./core"
import { issueClose } from "./core/issues/close"
import { issueComment } from "./core/issues/comment"
import { issueCreate } from "./core/issues/create"
import { issueDevelop } from "./core/issues/develop"
import { issueEdit } from "./core/issues/edit"
import { issueRead } from "./core/issues/read"
import { issueRelate } from "./core/issues/relate"
import { issueReopen } from "./core/issues/reopen"
import { projectCreate } from "./core/projects/create"
import { projectFieldEnsure } from "./core/projects/field-ensure"
import { projectLink, projectUnlink } from "./core/projects/link"
import { projectRead } from "./core/projects/read"
import { projectViewEnsure } from "./core/projects/view-ensure"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  issueRead,
  issueCreate,
  issueEdit,
  issueComment,
  issueClose,
  issueReopen,
  issueRelate,
  issueDevelop,
  projectRead,
  projectCreate,
  projectLink,
  projectUnlink,
  projectFieldEnsure,
  projectViewEnsure,
]
