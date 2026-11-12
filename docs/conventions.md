# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.
- **The MCP server takes the call's directory from the client.** It uses a
  directory sent with the call (Codex), else the client's first usable root,
  else the process's working directory; never inside the install directory.
  This keeps a server started in its install directory out of the working tree.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `gh_missing`       | `gh` is not installed                                                      |
| `gh_too_old`       | `gh` is older than the tools need                                          |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

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
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
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
  must know that something was left out. The facts a description drops past
  its eighth are counted on the same line, `(+N more)` after the facts, in
  every prompt, budget or none. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **A cut text says how much it leaves out.** A `…` also ends many ordinary
  messages, so it alone cannot tell a person that the text goes on, or how
  far. A text cut at its 2000 characters is followed by a notice line,
  `(+N more characters)`, and a fact's value cut at its 200 by the same
  notice after it on its line, where the line still fits the budget; a value
  the budget cuts further ends in `…` alone, since what it drops is no longer
  counted in the tool's characters. N counts the code points left out of what
  the tool gave, the unit the cut counts (`(+1 more character)` for one), and
  the notice is the plugin's own words, translated like the facts' notice.
  Only the head counts towards the budget, so the text's notice is lost
  wherever the harness cuts the text, which then shows its own end mark.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names. A surface the harness shows as
  written, such as its own clients, gets neither. A surface it names that the
  plugin does not know is one the harness does not cut, so it gets no budget,
  but it may render markup the plugin cannot tell, so it gets the strictest
  escaping of all: an escape shown as written reads as a stray backslash,
  while a name left unescaped can draw a link or a mention. A prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call no answer may let run is refused before anyone is asked.** Some
  calls are out of reach whatever the person would say, such as one naming
  an object the settings keep away from the agent; a prompt for it would
  show what it names and invite an "allow" that cannot be honored. A tool
  that can tell such a call from its arguments and settings gives a `gate`
  (see "The core contract"). Every entry point runs it before the approval
  and again before `execute`, so a refusal is the call's result, as an
  error, and no prompt is drawn: a native plugin asks nothing, and the
  Hermes plugin blocks the call. Unlike `targets` and `describe`, a gate
  fails closed: one that cannot tell fails the call with `internal_error`.
  Where the question itself cannot be resolved (the Hermes plugin's `target`
  fails or times out), the person is asked as before, and the run refuses
  the call after the answer. An MCP client draws its own prompt before the server sees the call, so
  there the refusal comes after the client's question, never after the run.
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

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.
- **`emoji`** maps a toolset name to the emoji the Hermes plugin shows beside
  it, merged over the package's `TOOLSET_EMOJI`; `""` shows no emoji for that
  toolset, and no other entry point shows an emoji. A value that is not a
  mapping, an entry whose value is not a string, and a name that is no toolset
  are ignored rather than refused: the setting only changes what is shown, so a
  typo must not take every tool away.
- **Options** are the package's own settings, the ones the tools themselves
  read, listed in `options` in `src/project.ts` (and `OPTIONS` in the Hermes
  plugin's `project.py`), each mapping a snake_case name to its type (`text`,
  `boolean`, `number`, `list`, `path` or `paths`) or a declaration with
  `{ type, integer, min, max }`. `integer: true` requires a whole `number`;
  `min` and `max` bound a `number` or count the items of a `list` or `paths`.
  Only `type` is required. Its flag is the name with `_` as `-` (a
  `boolean` flag takes no value), its variable is `<envPrefix>_<NAME>`
  uppercased, and its plugin option or setting is the name itself. A flag wins
  over its variable, an option over its variable, and a blank text or path or
  empty list counts as unset. A `path` is trimmed; `~` alone or followed by
  `/` (or the platform separator) stands for the home directory: `HOME` when
  it is absolute, else the account's.
  The expanded path must be absolute and reaches the tool normalized, without
  a filesystem check. A `paths` value is a list of such paths, comma-separated
  in a flag or variable and an array of strings in a plugin option; items are
  trimmed and blank items dropped, and none left counts as unset. Bounds
  check only a value that is given, after blanks are dropped; unset stays
  unset. Refused values are `invalid_argument`, naming the flag, variable or
  option and what it must be. A package should not have to check a directory
  or a limit again inside its tool. They reach a tool as `context.options`,
  keyed by name, and one that is not given is absent: a neutral default means
  unset, and the tool then does nothing extra. A tool reads an option when it
  runs, so a change applies on the next call.

## Skills

- **A skill names the toolset it documents**, under `metadata` in its
  frontmatter:

  ```yaml
  metadata:
    toolset: issues
  ```

  The Agent Skills format allows no other top-level key, and its validators
  refuse one. The value is a plain or quoted one-line scalar; any other form
  reads as no link. A folder's name never links a skill, so every entry point
  reads the link the same way without knowing the package's toolsets.

- **A native plugin registers a linked skill only when its toolset is on**:
  when the settings register at least one tool of that toolset, from the same
  selection the tools come from. A skill that describes tools the model does
  not have invites calls that fail. So `read_only`, `tools` and
  `exclude_tools` count too: a toolset whose every tool is left out takes its
  skill with it. A skill with no link is always registered.
- **Plugins that install the skill folder whole cannot follow the settings**:
  Claude Code, Codex, Grok Build and Antigravity load every skill, since the
  settings reach only the MCP server.
- **Every linked skill names one of the package's toolsets**; a test checks
  it, since a misspelt link would hide the skill wherever it is filtered.
- **A skill that works across toolsets names the one it cannot work without.**
  The link holds one toolset, and a skill linked to none would be registered
  with every tool it describes turned off. Its body says which steps to skip
  when another toolset's tools are missing, and it leans only on toolsets that
  are on by default, since the plugins that install the skill folder whole
  list it whatever the settings select.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- Any tool, read or write, may declare `gate(args, context)`, which throws a
  `ToolError` (usually `not_found`, worded as for an object that does not
  exist) for a call no approval may let run, and returns otherwise. `invoke`
  runs it after the arguments are checked and before `execute`; the entry
  points also run it before they ask (see "Write classes"). It is cheap, it
  reads only what it needs to decide, and its message says no more about
  the target than the arguments already do.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree), the values of the package's own settings as `options` (see
  "Toolsets and settings"; `gate`, `describe` and `targets` get them too) and
  an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every variable the tools read besides the settings is named in
  `toolVariables` in `src/project.ts`**, whether a tool reads it itself or
  passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `toolVariables`: a variable left out is set everywhere but in Codex.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.

## The GitHub tools

The rules below are github-tools' own, on top of everything above; where one
changes a rule above, it says so. The discussion behind the rules is on
[#2](https://github.com/craft-agent/github-tools/issues/2) and
[#3](https://github.com/craft-agent/github-tools/issues/3).

### Names

- **Tool IDs follow the GitHub CLI's command groups**: `github_issue_create`,
  `github_project_item_add` for `gh issue create` and `gh project item-add`, so
  a name maps to a command anyone can look up. The `github_` prefix is
  `toolPrefix` in `src/project.ts`.
- **Verbs are the CLI's**: `view`, `list`, `create`, `edit`, `close`, `reopen`,
  `comment`, `review`, `ready`, `merge`, `delete`, `add` for putting an item
  on a board, and for Actions `run` (start a workflow, `gh workflow run`),
  `rerun` and `cancel` (`gh run rerun`, `gh run cancel`). Native stacks are
  `github_stack_*`, after the `gh stack` extension's command group (`link`,
  and `unlink` for its `unstack`). A verb of our own, besides the starter's
  `read`, `resolve` and `ensure`, only where the CLI has no command for the
  operation:

  | Verb         | Means                                                   |
  | ------------ | ------------------------------------------------------- |
  | `relate`     | set an issue's parent, sub-issues and dependencies      |
  | `visibility` | change who can read a repository                        |
  | `publish`    | make a draft release public: tag it and notify watchers |

  `visibility` has a tool of its own although the CLI changes it with
  `repo edit`: it is administrative, and folded into `github_repo_edit` it
  would make every description change ask like it. Where a CLI group has no
  write command (milestones, rulesets), the writes take the CLI's usual
  `create`, `edit` and `delete`.

  `publish` has a tool of its own although the CLI publishes a draft with
  `release edit --draft=false`: it is administrative, and folded into
  `github_release_edit` it would make every notes edit ask like it.

- **A read tool's `method` values are the CLI's read verbs** (`view`, `list`,
  …), and `resolve` finds which board, repository or object a call means.

### Arguments

- **Keys line up with the GitHub API's fields** (`state_reason`,
  `issue_number`), in snake_case.
- **Lists change through flat arguments** named for the GitHub object:
  `add_labels`, `remove_labels`, `add_assignees`; the argument that replaces a
  whole list is `labels`.
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
- **A bare number in the tools' own install directory fails.** That directory
  is a checkout of this package, whose `origin` is not the caller's project, so
  the call fails, saying so, instead of reading this package's issues; `repo`
  or a qualified reference still works.

### Results

- **The steps after a create.** Once a tool has created something, a later step of the same call that fails (a milestone, a
  relation, a board item) does not throw; it is listed under `errors` as the
  rule above says. When the create itself reports a failure, the tool looks
  for what it may have made (a `gh` command can make an object, then fail on a
  second request) and returns it under `errors.create` rather than failing.
- **What a GitHub does not have reads as `null`.** An older GitHub (an
  Enterprise Server) rejects a whole query that names a field it lacks, such
  as issue fields. The read then runs again without it and reports `null`
  there, never `{}` or `[]`, which would say there is none.
- **A write to a repository the viewer does not own succeeds** and says
  `foreign: true`, so the caller notices it is in someone else's tracker.
- **Text read from GitHub** (bodies, comments, titles and logs) is what GitHub
  holds, which is what a tool returns.

### Errors

- **The caller of the table is the viewer**, the account `gh` is logged in as:
  `not_found` is also what an object reads as when the viewer cannot see it,
  `forbidden` when the viewer lacks the permission.
- **`unauthenticated`, `gh_missing` and `gh_too_old` come from `gh`**, and
  `rate_limited` is GitHub's own refusal. The `gh` runner tells them apart (see
  "The `gh` runner").

### Write classes of GitHub operations

- **`openWorldHint` is `true` for every tool**, since each one reaches GitHub.
- **The classes, by example:**

  | Class             | Examples                                                   |
  | ----------------- | ---------------------------------------------------------- |
  | read              | view, list, resolve                                        |
  | add               | create, comment, add an item                               |
  | idempotent change | ensure, relate, adding a label                             |
  | overwrite         | editing a body or title, close, reopen                     |
  | administrative    | merge, visibility, delete, publishing, every Actions write |

- **Every Actions write is administrative**: starting, re-running or
  cancelling a run. A workflow can deploy, publish or spend whatever its name
  says, and stopping one halfway can leave a deploy half done.

### Targets

- **A target is a repository or a board.** The resolvers are made by
  `githubTargets`, from a map of argument names to the kind of target each
  holds: `repo`, an issue or pull request reference (`issue`, `pull`) or a list
  of issues (`issues`), a workflow run (`run`), a board (`board`), a board that
  is written to only when it is given (`optional_board`), a board item (`item`)
  and the owner a board is created for (`owner`). Every argument of the map
  must be an argument of the tool. A bare number means the call's own
  repository, and a repository is named in lowercase.
- **A board is named `owner/projects/N`.** A board belongs to a user or an
  organization, not to a repository, so its writes name the board rather than
  the working tree's repository. A board the call does not name is found with
  the same lookup the tool uses, which reads but never writes. Putting an
  issue or pull request on a board names the board only, since the issue does
  not change; a call that also writes to a repository (linking one, turning a
  draft into an issue) names both. Creating a board names `owner/projects/new`,
  so an "always" answer lets new boards be made for that owner and no
  existing board be written to.

### Approval prompts of the GitHub tools

The rules above are the starter's; this section is what this package adds
to them. Every write tool, whatever its class, follows it.

- **Every write tool gives an `intent`.** It starts with `About to`, names the
  object as its title does (`GitHub issue`, `pull request`), and says only
  what every call of the tool does: where a call's direction depends on an
  argument (`undo` on `github_pr_ready`) or may find the work already done
  (`github_project_field_ensure`), the phrase says what the tool settles, not
  which way it went. A read tool gives none, since it asks nothing.
- **Translations sit beside the tools, one table per directory** (`words.ts`
  of `issues`, `pull-requests`, `projects`, `repos`, `releases`, `runs` and
  `workflows`), and `src/words.ts` merges them with the shared fact words.
  `src/words.test.ts` fails on a key no tool uses, on a word a tool uses
  without a key, and on a template whose translation changes its
  placeholders, so a table cannot drift from the tools.
- **A tool is described from what it read, never from what the model said.**
  A headline names the issue, pull request or board by the title GitHub
  returns; the arguments only say which one. A tool that cannot tell its
  target before it runs gives its intent alone.
- **Facts this package adds** are listed here, each with the tools that give
  it. A fact appears only where it changes the answer: `State` is not shown
  for an open issue about to be closed, since it is always open.
  `src/core/write-facts.ts` holds the ones several toolsets share.
  - `State` (`stateFact`): the target's state as `Open`, `Closed`, `Merged`
    or `Draft`. A comment on a closed issue shows it; closing, reopening or
    merging a target that is already in that state shows `Already closed;
nothing is sent`, `Already open; nothing is sent` or `Already merged;
nothing is sent` as its only fact and no text.
  - A change to a list (`changeFact`): `Labels`, `Assignees`, `Blocked by`,
    `Sub-issues`, `Blocking`, `Issue fields` as `+added −removed`. The names
    are data, never translated.
  - Issue tools: `Reason` and `Duplicate of` (close); `Title`, `Body`
    (`Replaced`, `Appended` or `Cleared`), `Milestone`, `Kind` (edit);
    `Parent`, `Board` (create, relate); `Branch` and `Base` (develop). A
    milestone the call creates reads `<name> (new)`.
  - Pull request tools: `Base`, `Head` (create, edit), `Closes` (the issues a
    pull request names, or the ones a merge closes, as `owner/repo#N` even in
    other repositories), `Reviewers`, `Attachments` (the file names), `Commit`
    and `Line comments` (review), `Method` (`Merge commit`, `Squash` or
    `Rebase`), `Also merges` (the lower layers a merge takes along) and
    `Branch` (`Deleted after merge`) (merge), `Layers` (a stack's pull
    requests by their real titles, bottom to top), `Stack` (`New stack` or
    `Extends a stack of N`) and `Stays` (stack link and unlink). A review's
    text is its body followed by each line comment under its `path:line`. A
    call that is refused before it writes gets no description at all.
  - Board tools: `Board` (the board's real title), `Fields` (one fact for all
    the field writes, as `Status: Todo → Done; Target: — → 2026-12-01`, since
    a field's name is data and never a fact's label), `Cleared fields`,
    `Owner`, `Template`, `Link`, `Default view` and `Views` (create), `Type`
    and `Options` (field ensure), `Layout`, `Filter`, `Grouped by`,
    `Columns by` and `Sorted by` (view ensure). A call that finds the board
    already in the state it asks for shows one `State` fact saying nothing is
    sent.
  - Repository tools: `Visibility` (a repository's own, or as a change such
    as `Private to public`), `Template`, `License`, `Gitignore`, `README`
    and `Homepage` (create); `Default branch`, `Topics`, `Features`,
    `Merge methods`, `Merge options` and `Template repository` (edit, only
    for what changes); `Enforcement`, `Target`, `Refs`, `Excluded refs`,
    `Rules`, `Rule parameters` and `Bypass` (rulesets); `Color` and
    `Due date` (labels, milestones). A call the tool would refuse, such as
    archiving an archived repository, gets no description; one it accepts
    without changing anything shows `Already in place; nothing is sent`. The
    description a call sets is its text; one it clears is a `Cleared` fact.
  - Release tools: `Tag target` (not `Target`, which is a ruleset's word and
    can have only one translation), `Notes` (`Generated by GitHub`),
    `Prerelease`, `Latest`, `Tag`, `Commit` (the short commit a publish makes
    the tag name, or `<sha> (existing tag)`), `State` (`Draft` or
    `Published`) and `Assets` (a delete). The notes are the text under
    `Release notes`.
  - Actions tools: `Branch`, `Event` and `Status` (cancel), `Scope` (`Failed
jobs only`, `One job` or `All jobs`), `Job` and `Debug logging`
    (re-run), `Ref`, `Commit` and `Inputs` (start), where `Inputs` is one
    fact for all the `name: value` pairs, since an input's name is data.
  - A replacing body is pinned by the digest of the body it replaces, a new
    development branch by the head commit of its base, a new pull request, a
    review and a merge by the head commit of the pull request, a merge that
    takes lower layers along by the digest of their commits, a ruleset edit
    or delete by the ruleset's update time, a release publish by the full
    commit it tags, replaced release notes by their digest, a re-run by the
    commit and attempt it repeats and a workflow start by the full commit of
    its ref, since the prompt shows none of them in full.

### Toolsets of the GitHub tools

- **Six toolsets**, listed in `src/project.ts`: `issues`, `pull_requests`,
  `projects`, `repos`, `releases` and `actions`. The first three are on by
  default; `repos`, `releases` and `actions` are opt-in. Some plugins pass no
  settings at all, and they ship every skill: a skill whose tools are off by
  default would describe tools the agent does not have.
- **`github-planning` is linked to `issues`**, the toolset it cannot work
  without (see "Skills"). It also uses the board tools, from `projects`, which
  is on by default too, and its body says what to skip when they are missing.

### The `gh` runner

- **Every call to GitHub goes through one runner** (`src/core/gh.ts`), on the
  starter's rules for a program a tool runs, with an explicit environment:
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1` and the
  other settings that keep `gh` from prompting, paging or coloring, and `gh`'s
  own authentication, network and search-path variables passed through.
- **`toolVariables` in `src/project.ts` is empty.** The variables the runner
  passes through to `gh` are the list in `src/core/gh.ts`, and none of them is
  named for a harness that forwards only named variables.
- **The time limit is 120 s by default** for a `gh` call, and a version check
  has its own, shorter one.
- **It checks the `gh` version once per process** against the minimum the
  tools need (`gh_too_old` otherwise, `gh_missing` when there is no `gh`). A
  feature that needs a newer `gh` (attachments) checks for it only in the calls
  that use it, so every other call keeps the lower minimum.
- **A failure keeps GitHub's reason.** `gh api` prints a failed reply's body on
  stdout and only its status on stderr; the reply's `errors` join the message.

### Tests of the GitHub tools

- **One fake `gh` on `PATH`** (`src/testing/fake-gh.ts`), matching CLI
  arguments and GraphQL queries to canned replies, shared by every domain,
  with the fixtures beside it in `src/testing/`. No test reaches GitHub.
