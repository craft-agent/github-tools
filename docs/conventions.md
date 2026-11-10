# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; the
discussion behind them is on
[#2](https://github.com/craft-agent/github-tools/issues/2) and
[#3](https://github.com/craft-agent/github-tools/issues/3).

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
  `comment`, `review`, `ready`, `merge`, `delete`, `add` for putting an item
  on a board, and for Actions `run` (start a workflow, `gh workflow run`),
  `rerun` and `cancel` (`gh run rerun`, `gh run cancel`). Native stacks are
  `github_stack_*`, after the `gh stack` extension's command group (`link`,
  and `unlink` for its `unstack`). A verb of our own only where the CLI has no
  command for the operation:

  | Verb         | Means                                                        |
  | ------------ | ------------------------------------------------------------ |
  | `read`       | the one read tool of a domain (below)                        |
  | `relate`     | set an issue's parent, sub-issues and dependencies           |
  | `resolve`    | find which board, repository or object a call means          |
  | `ensure`     | create when missing, reuse when present; never a second copy |
  | `visibility` | change who can read a repository                             |
  | `publish`    | make a draft release public: tag it and notify watchers      |

  `visibility` has a tool of its own although the CLI changes it with
  `repo edit`: it is administrative, and folded into `github_repo_edit` it
  would make every description change ask like it. Where a CLI group has no
  write command (milestones, rulesets), the writes take the CLI's usual
  `create`, `edit` and `delete`.

  `publish` has a tool of its own although the CLI publishes a draft with
  `release edit --draft=false`: it is administrative, and folded into
  `github_release_edit` it would make every notes edit ask like it.

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
- **Field values are one map by field name.** A board's fields (`fields`) and
  an organization's issue fields (`issue_fields`) take `{name: value}`, names
  and options matched without regard to case; clearing takes a list of names
  (`clear_fields`, `clear_issue_fields`). A field the owner adds or renames
  stays reachable without a new argument. Every name, option and value is
  checked against the field definitions before anything is written, and a
  refusal names the choices there are.
- **References.** An issue or pull request is `12`, `#12`, `owner/repo#12` or
  its URL; a board is its number, `owner/number`, its URL or its title; a
  workflow run is its id or its URL. A bare number means the working tree's
  repository (its `origin` on GitHub); `repo` (`owner/name`) names another. A
  call that needs a repository and finds neither fails, saying so.
- **A board not named is looked up, never guessed.** By title (the `project`
  argument when it is no reference, default `Roadmap`), in order: the owner
  given, else the boards linked to the repository, the organization that owns
  it, and the viewer. Several candidates on one route stop the call with the
  candidates listed, and a repository that cannot be read fails instead of
  falling through to another route.
- **A write that acts on a commit takes `head_sha`.** Opening, reviewing and
  merging a pull request check, when it is given, that the branch on GitHub is
  still at that commit, and stop with `stale` before writing otherwise. The
  caller pushed or read that commit; anything newer arrived unseen. Publishing
  a release checks that the commit its tag would name is the one given, stops
  with `stale` otherwise, and pins a new tag to the commit it checked.
  Starting a workflow checks the commit its ref names; GitHub starts a
  workflow by ref, not by commit, so the run's own commit is read afterwards
  and a difference is reported rather than prevented.
- **A read that waits is bounded.** A read that waits for GitHub (checks to
  settle, a workflow run to finish) waits at most `wait` seconds, 45 by
  default, then returns what it has and says to call again. Hosts stop a tool
  call after about a minute, so a longer wait would end in a failed call
  instead of an answer.
- **The tools' own install directory is never the working tree.** A harness may
  start a tool inside the directory the package is installed in, a checkout of
  this package, whose `origin` is not the caller's project. A bare number there
  fails, saying so, instead of reading this package's issues; `repo` or a
  qualified reference still works.

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
  and lists the failed steps under `errors`, keyed by step. When the create
  itself reports a failure, the tool looks for what it may have made (a `gh`
  command can make an object, then fail on a second request) and returns it
  under `errors.create` rather than failing.
- **What a GitHub does not have reads as `null`.** An older GitHub (an
  Enterprise Server) rejects a whole query that names a field it lacks, such
  as issue fields. The read then runs again without it and reports `null`
  there, never `{}` or `[]`, which would say there is none.
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

- **Structure the caller needs goes in `details`, not in the message.** When
  fixing the cause takes more than a sentence (the lint violations, the
  findings, the output of a hook), the error carries it as `details`: a JSON
  object with snake_case keys, like a result. A model then reads the fields
  instead of parsing them back out of prose; the message still says what to
  do next on its own.
- **`details` is fixed when the error is made.** `ToolError` keeps a frozen
  JSON copy, so every entry point renders the same value. The copy is what
  JSON makes of it (`undefined` is dropped, `NaN` becomes `null`), and a value
  JSON cannot write at all, such as a cycle or a `BigInt`, fails where it was
  thrown, as a bug, not where it is rendered.
- **Each entry point passes `details` on only when it is set**, so an error
  without it reads as it always did. The MCP server and the command line put
  it beside the code and the message, as `error.details`. The OpenCode and
  Hermes plugins, whose errors are text, append it to `<code>: <message>` as
  JSON on a line of its own.
- The `errors` of a partial result (`StepErrors`) stay `<code>: <message>`
  strings.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool, since each one reaches GitHub.

| Class             | Examples                                                   | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ---------------------------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                                        | `true`         | —                 | `true`           |
| add               | create, comment, add an item                               | `false`        | `false`           | `false`          |
| idempotent change | ensure, relate, adding a label                             | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, close, reopen                     | `false`        | `true`            | `true`           |
| administrative    | merge, visibility, delete, publishing, every Actions write | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **Every Actions write is administrative**: starting, re-running or
  cancelling a run. A workflow can deploy, publish or spend whatever its name
  says, and stopping one halfway can leave a deploy half done.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for every repository and board the call writes to.** Each write
  tool declares which arguments name one (`repo`, an issue or pull request
  reference, a workflow run, a list of issues, a board, or a board that is
  written to only when it is given); a bare number means the call's own
  repository, and what cannot be told is `*`. An "always" answer then covers
  only what it named, never a write into another repository or board.
- **A board is named `owner/projects/N`.** A board belongs to a user or an
  organization, not to a repository, so its writes name the board rather than
  the working tree's repository. A board the call does not name is found with
  the same lookup the tool uses, which reads but never writes. Putting an
  issue or pull request on a board names the board only, since the issue does
  not change; a call that also writes to a repository (linking one, turning a
  draft into an issue) names both. Creating a board names `owner/projects/new`,
  so an "always" answer lets new boards be made for that owner and no
  existing board be written to.
- **It shows what the call carries, where the tool can say.** Targets are
  ids, so they cannot tell one kind of target from another, and the person
  decides on the text, the file or the kind of target as much as on where it
  goes. A write tool's `describe` says it. An MCP client draws the call's
  arguments in its own prompt, so the MCP server adds nothing.
- **Every native plugin's prompt has one shape**, so a person reads every
  tool's prompt the same way:

  ```text
  About to create "todo.md"

  --- Details ---

  Target: /work/tree/notes/todo.md
  Size: 42 bytes

  --- Note text ---

  # Todo
  ```

  The headline says what the agent is about to do, as its next step; the
  Details name each target on a `Target` line, then the tool's facts; the
  last section is the text the call carries, under the tool's own label. A
  section with nothing to show is left out, so a tool without `describe`
  shows its intent and its targets, and one whose targets cannot be told
  shows its intent alone. The harness names the tool beside the prompt, so
  the prompt does not repeat its id.

- **A write tool states its intent.** Besides its title, which names the
  tool wherever tools are listed, a write tool gives an `intent`: a fixed
  phrase in the headline's tone that carries no value (`About to create a
note`). The prompt shows it wherever no headline can stand: a tool without
  `describe`, a headline that is dropped, and one that gives way to keep the
  targets within the budget. A tool without an intent shows its title there.

- **The tool's words are fixed; what the call carries is data.** A model
  chooses the arguments and nothing else, and a prompt is only as good as the
  person's trust in its lines. The headline is the tool's intent, or a
  template the tool picks (`About to create {file}`) whose values the entry
  point quotes, so where the tool's words end and the call's data begins is
  always visible. A value comes from what the tool resolved, never from a
  model's account of it (the record's real name, not the name the model
  gave). The text section holds what the call writes, as it is, never a
  summary of it; a summary the tool can compute is a fact (`Size`, `Lines`).
- **Facts are short and ordered by what they decide.** A label is a noun of
  one or two words, in English like the tool's title, and a value carries
  its unit (`42 bytes`). A value with a unit or other words of the tool's is
  a template the tool picks with the values it holds (`{bytes} bytes` with
  `bytes: 42`), so the unit is the tool's word and the number the call's
  data; the tool picks the English form for the count (`{bytes} byte` for
  one), and numbers are shown as written, without digit grouping. A plain
  string value has no words of the tool's. The fact that changes the person's answer comes
  first (the kind of target, whether it overwrites); amounts come last. A
  fact never repeats the headline or a target. `src/core/facts.ts` holds the
  facts every package can use (`sizeFact`); a package adds its own beside its
  tools in the same form and lists them in its section below.
- **The head of the prompt comes first and fits; the text comes last.** Some
  harnesses cut a prompt from its end at a few hundred characters, so the
  headline, the targets and the facts are kept within the budget of where the
  prompt is shown, and the text is what is cut. A headline that would push a
  target past the cut gives way to the intent, since the targets are what an
  "always" answer stores. Facts that do not fit are counted on a notice
  line, which stays even when the head alone fills the budget: a person
  must know that something was left out. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names: a surface it names that the plugin
  does not know is one the harness does not cut, and gets neither, since
  another surface's escapes would show there as written. Only a prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. The hash
  takes the description whole, before the budgets above cut it: a text past
  its 2000 characters, a value past its cut and the facts past the eighth
  are what the call carries too, so a change there is a change of the call
  even where the prompt could not show it. Right
  before the call runs, the entry point resolves both again, and a call
  whose hash differs, or whose description can no longer be told, fails with
  `stale` without running; the person is asked again on the next call. A
  call whose prompt showed no description pins nothing and runs as before,
  and so does every call of a tool without `describe`. A `describe` may also
  give `pins`, values the prompt does not show that the call must still find
  unchanged (a file's hash, beside a size that can stay the same); they go
  into the hash and nowhere else. A `describe` therefore gives the same
  answer for the same state: a value that changes on every call, such as the
  time, makes every call `stale`. The check narrows the gap between the
  answer and the run to the moment before `execute`; a tool that must close
  it entirely still checks inside `execute`. An MCP client draws the call's
  arguments, not a description, so the MCP server pins nothing.
- **The prompt speaks the language set for the harness.** A native plugin
  draws its prompt in the language of the `language` setting, else in the
  harness's own display language where it has one (Hermes's
  `display.language`), else in English. No harness tells a plugin who
  approves a call, so this is the language set where the plugin runs, not
  each person's. The server's locale (`LANG`) is never read: it is the
  machine's, and a person reading English on a machine set to another
  language would see the prompt change. A tag matches its own table, else
  the one of its first subtag (`ja-JP` and `ja_JP` are `ja`; `zh-Hant` can
  have its own), and a language the package has no words for falls back to
  English without a word. An MCP client draws its own prompt,
  so the MCP server takes no `language`.
- **Translations are tables keyed by the English words.** The plugin's own
  words (`Details`, `Target`, `(+N more)`) and a tool's (its title, its
  intent, its headline templates, its fact labels, its value templates and its text
  label) are written in
  English in the code. Per language, a package gives one table from those
  English words to their translation (`src/words.ts`), and the entry point
  looks each word up as it draws the prompt, so a tool's code does not change.
  A translated template must hold the same placeholders as the English one
  and keep within its limits, or the English one is used, so a translation
  cannot move the line between the tool's words and the call's data. Values
  are the call's data and are never translated: a value template is looked
  up and its values filled in after (`{bytes} バイト`), and a plain string
  value stays as the tool wrote it. A translation is marked like every other
  piece of the prompt.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain. `issues`, `pull_requests` and `projects` are on
  by default; `repos`, `releases` and `actions` are opt-in. A small default
  keeps the model's choice sharp, but some plugins pass no settings at all, and
  they ship every skill: a skill whose tools are off by default would describe
  tools the agent does not have.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares its `targets`: the arguments that name a
  repository the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree) and an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun.

## The `gh` runner

- **Every call goes through one runner**, with an explicit environment:
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, and `gh`'s
  own authentication passed through. Nothing waits on a prompt, and output
  parses the same everywhere.
- **Every variable the tools read besides the settings is named in
  `TOOL_VARIABLES` in `src/entry/settings.ts`**, whether a tool reads it itself
  or passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `TOOL_VARIABLES`: a variable left out is set everywhere but in Codex.
- **Every call has a time limit** (120 s by default), and a call that is
  stopped, by that limit or by cancellation, has its child process killed:
  `SIGTERM`, then `SIGKILL` after two seconds. A hung `gh` neither holds a
  harness forever nor outlives its call.
- **It checks the `gh` version once per process** against the minimum the
  tools need, and maps `gh`'s failures to the error codes above. A feature that
  needs a newer `gh` (attachments) checks for it only in the calls that use
  it, so every other call keeps the lower minimum.
- **A failure keeps GitHub's reason.** `gh api` prints a failed reply's body on
  stdout and only its status on stderr; the reply's `errors` join the message.

## Tests

- **One fake `gh` on `PATH`**, matching CLI arguments and GraphQL queries to
  canned replies, shared by every domain. No test reaches GitHub.
- Tests run on `bun test`; CI also starts the built MCP server under Node and
  lists its tools, so a runtime-only API cannot slip in unnoticed.
