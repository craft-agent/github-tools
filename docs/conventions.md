# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; the
discussion behind them is on
[#2](https://github.com/craftsamo/agent-github/issues/2) and
[#3](https://github.com/craftsamo/agent-github/issues/3).

## Names

- **Tool IDs are `github_<domain>_<verb>`**: `github_issue_create`,
  `github_project_item_add`. The word order follows the GitHub CLI's command
  groups (`gh issue create`, `gh project item-add`), so a name maps to a
  command anyone can look up. The `github_` prefix keeps a name unambiguous
  where a harness lists every tool in one namespace.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are the CLI's**: `view`, `list`, `create`, `edit`, `close`, `reopen`,
  `comment`, `delete`, and `add` for putting an item on a board. A verb of our
  own only where the CLI has no command for the operation:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `relate`  | set an issue's parent, sub-issues and dependencies           |
  | `resolve` | find which board, repository or object a call means          |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `github_<domain>_read` takes a `method` argument whose values are the CLI's
  read verbs (`view`, `list`, …). A model picks tools worse as their number
  grows, and reads share one set of annotations, so folding them loses
  nothing. Writes stay apart because a merged write tool would carry its
  strictest class: creating an issue would ask like overwriting one.
- **Names stay within about 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads, and it lines up with the GitHub API's fields
  (`state_reason`, `issue_number`).
- **Lists change through flat arguments**: `add_labels`, `remove_labels`,
  `add_assignees`. Shallow schemas are read reliably by every model the
  harnesses run. An argument that replaces a whole list, where one is needed,
  is named for the list (`labels`) and its description says it replaces.
- **References.** An issue or pull request is `12`, `#12`, `owner/repo#12` or
  its URL; a board is its number, `owner/number` or its URL. A bare number
  means the working tree's repository (its `origin` on GitHub); `repo`
  (`owner/name`) names another. A call that needs a repository and finds
  neither fails, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails (a milestone, a
  relation, a board item) does not throw. The result names what was created
  and lists the failed steps under `errors`, keyed by step.
- **A write to a repository the viewer does not own succeeds** and says
  `foreign: true`, so the caller notices it is in someone else's tracker.
- **Text read from GitHub is returned as it is.** Bodies, comments, titles and
  logs are data, never instructions; every read tool's description and the
  skills say so. Nothing is wrapped or rewritten, so what a tool returns is
  what GitHub holds.

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `not_found`        | the object does not exist, or the viewer cannot see it                   |
| `forbidden`        | the viewer lacks the permission the call needs                           |
| `invalid_argument` | the arguments cannot describe a valid call                               |
| `stale`            | what the call relied on changed before it could finish                   |
| `unauthenticated`  | `gh` is not logged in                                                    |
| `gh_missing`       | `gh` is not installed                                                    |
| `gh_too_old`       | `gh` is older than the tools need                                        |
| `rate_limited`     | GitHub refused the call for its rate limit                               |
| `declined`         | the person declined a confirmation the tool asked for                    |
| `github_error`     | GitHub or `gh` failed for another reason; the message carries their text |

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool, since each one reaches GitHub.

| Class             | Examples                               | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | -------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                    | `true`         | —                 | `true`           |
| add               | create, comment, add an item           | `false`        | `false`           | `false`          |
| idempotent change | ensure, relate, adding a label         | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, close, reopen | `false`        | `true`            | `true`           |
| administrative    | merge, visibility, delete, publishing  | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **Only administrative tools confirm during the call.** Where the entry point
  can ask the person (form-mode elicitation, where the client advertises it),
  the tool states what will happen in plain words and stops on anything but
  an accept. Where it cannot, the harness's own approval is the confirmation.
  These tools also carry `_meta["anthropic/requiresUserInteraction"]: true`,
  which makes Claude Code ask even under an allow rule.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain. `issues` and `pull_requests` are on by
  default; `projects`, `repos`, `releases` and `actions` are opt-in. A small
  default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it.
- `execute(args, context)` gets the working directory, an abort signal and an
  optional `confirm(request) => Promise<boolean>` hook. Nothing in it names a
  harness. A tool that needs a confirmation treats a missing hook as the
  harness having approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun.

## The `gh` runner

- **Every call goes through one runner**, with an explicit environment:
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, and `gh`'s
  own authentication passed through. Nothing waits on a prompt, and output
  parses the same everywhere.
- **Every call has a time limit** (120 s by default), and a call that is
  stopped, by that limit or by cancellation, has its child process killed:
  `SIGTERM`, then `SIGKILL` after two seconds. A hung `gh` neither holds a
  harness forever nor outlives its call.
- **It checks the `gh` version once per process** against the minimum the
  tools need, and maps `gh`'s failures to the error codes above.

## Tests

- **One fake `gh` on `PATH`**, matching CLI arguments and GraphQL queries to
  canned replies, shared by every domain. No test reaches GitHub.
- Tests run on `bun test`; CI also starts the built MCP server under Node and
  lists its tools, so a runtime-only API cannot slip in unnoticed.
