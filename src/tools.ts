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
import { projectItemAdd } from "./core/projects/item-add"
import { projectItemArchive, projectItemUnarchive } from "./core/projects/item-archive"
import { projectItemConvert } from "./core/projects/item-convert"
import { projectItemCreate } from "./core/projects/item-create"
import { projectItemEdit } from "./core/projects/item-edit"
import { projectLink, projectUnlink } from "./core/projects/link"
import { projectRead } from "./core/projects/read"
import { projectViewEnsure } from "./core/projects/view-ensure"
import { prClose } from "./core/pull-requests/close"
import { prComment } from "./core/pull-requests/comment"
import { prCreate } from "./core/pull-requests/create"
import { prEdit } from "./core/pull-requests/edit"
import { prMerge } from "./core/pull-requests/merge"
import { prRead } from "./core/pull-requests/read"
import { prReady } from "./core/pull-requests/ready"
import { prReopen } from "./core/pull-requests/reopen"
import { prReview } from "./core/pull-requests/review"
import { stackLink } from "./core/pull-requests/stack-link"
import { stackRead } from "./core/pull-requests/stack-read"
import { stackUnlink } from "./core/pull-requests/stack-unlink"
import { labelRead } from "./core/repos/label-read"
import { labelCreate } from "./core/repos/label-create"
import { labelEdit } from "./core/repos/label-edit"
import { labelDelete } from "./core/repos/label-delete"
import { milestoneCreate } from "./core/repos/milestone-create"
import { milestoneEdit } from "./core/repos/milestone-edit"
import { milestoneRead } from "./core/repos/milestone-read"
import { repoArchive } from "./core/repos/repo-archive"
import { repoCreate } from "./core/repos/repo-create"
import { repoEdit } from "./core/repos/repo-edit"
import { repoRead } from "./core/repos/repo-read"
import { repoUnarchive } from "./core/repos/repo-unarchive"
import { repoVisibility } from "./core/repos/repo-visibility"
import { rulesetCreate } from "./core/repos/ruleset-create"
import { rulesetDelete } from "./core/repos/ruleset-delete"
import { rulesetEdit } from "./core/repos/ruleset-edit"
import { rulesetRead } from "./core/repos/ruleset-read"
import { releaseRead } from "./core/releases/release-read"

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
  prRead,
  prCreate,
  prEdit,
  prComment,
  prReady,
  prClose,
  prReopen,
  prReview,
  prMerge,
  stackRead,
  stackLink,
  stackUnlink,
  projectRead,
  projectCreate,
  projectLink,
  projectUnlink,
  projectFieldEnsure,
  projectViewEnsure,
  projectItemAdd,
  projectItemCreate,
  projectItemEdit,
  projectItemArchive,
  projectItemUnarchive,
  projectItemConvert,
  repoRead,
  labelRead,
  milestoneRead,
  rulesetRead,
  labelCreate,
  labelEdit,
  labelDelete,
  milestoneCreate,
  milestoneEdit,
  repoCreate,
  repoEdit,
  repoVisibility,
  repoArchive,
  repoUnarchive,
  rulesetCreate,
  rulesetEdit,
  rulesetDelete,
  releaseRead,
]
