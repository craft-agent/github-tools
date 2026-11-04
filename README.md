# github-tools

GitHub tools for coding agents: issues, project boards, pull requests,
repositories, releases and Actions. One implementation, delivered to each
agent harness in the form that suits it best.

| Harness        | Delivery                                         | Pinned by                                     |
| -------------- | ------------------------------------------------ | --------------------------------------------- |
| OpenCode V2    | native plugin (npm package, with skills)         | the version in the package                    |
| OpenCode V1    | native plugin (npm package, no skills)           | the version in the package                    |
| Claude Code    | plugin: MCP server and skills                    | the release tag, as the ref                   |
| Codex          | plugin: MCP server and skills                    | the release tag, as the ref                   |
| Grok Build     | plugin: MCP server and skills                    | the release tag, as `@ref`                    |
| Antigravity    | plugin: MCP server and skills (not yet verified) | the release tag's tree URL (not yet verified) |
| Hermes Agent   | native plugin (Python, calls the command line)   | the release commit, as the SHA                |
| other MCP host | MCP server from npm                              | the version in the package                    |

0.3.0 moved the package from `craftsamo/agent-github` to `craft-agent/github-tools` and renamed it: npm `@craftsamo/github-tools` (was `@craftsamo/agent-github`, now deprecated), plugin and MCP server `github-tools`, programs `craft-agent-github` and `craft-agent-github-cli`, settings `CRAFT_AGENT_GITHUB_*`. Allow rules, plugin installs and MCP configurations written for 0.2.0 change; the tool IDs do not.

The tools need [Node.js](https://nodejs.org/) 24 or later and the
[GitHub CLI](https://cli.github.com/), authenticated as you.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craft-agent/github-tools/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "@craftsamo/github-tools@<version>",
      "options": { "toolsets": ["issues", "pull_requests", "projects"] }
    }
  ],
  "permissions": [{ "action": "github_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/github-tools@<version>", { "toolsets": ["issues", "pull_requests", "projects"] }]],
  "permission": { "github_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `github_*` glob
is safe.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/github-tools@<version>
tar -xzf craftsamo-github-tools-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-github-tools-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craft-agent/github-tools#v<version>
claude plugin install github-tools@craft-agent
```

### Codex

```sh
codex plugin marketplace add craft-agent/github-tools --ref v<version>
codex plugin add github-tools@craft-agent
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__github_tools__github_issue_*`. It starts the MCP server in the plugin's
install directory, so name issues as `owner/repo#N` or pass `repo` (a bare number
fails there with a message saying so).

### Grok Build

```sh
grok plugin install craft-agent/github-tools@v<version> --trust
```

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`. The pinning and the install command are not yet verified
on a real install.

```sh
agy plugin install https://github.com/craft-agent/github-tools/tree/v<version>
```

### Hermes Agent

Hermes installs a commit, not a tag, and the plugin installs disabled:

```sh
hermes plugins install craft-agent/github-tools --ref <sha>
hermes plugins enable github-tools
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin.

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "github-tools": {
      "command": "npx",
      "args": ["-y", "@craftsamo/github-tools@<version>", "--toolsets", "issues,pull_requests,projects"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools. A
toolset with no tools yet registers none (0.2.0 ships the `issues` tools).

### Issues (`issues`)

| Tool                   | What it does                                                                              | Class      |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `github_issue_read`    | `view` one issue in full, or `list` a repository's issues or a parent's sub-issues        | read       |
| `github_issue_create`  | create an issue with its kind, labels, assignees, milestone, parent and blocked-by issues | add        |
| `github_issue_edit`    | change the title, body (or append to it), kind, labels, assignees or milestone            | overwrite  |
| `github_issue_comment` | comment on an issue                                                                       | add        |
| `github_issue_close`   | close with a reason (`completed`, `not_planned`, `duplicate`)                             | overwrite  |
| `github_issue_reopen`  | reopen a closed issue                                                                     | overwrite  |
| `github_issue_relate`  | set the parent, sub-issues, blocked-by and blocking issues, sending only what differs     | idempotent |
| `github_issue_develop` | create a branch on GitHub linked to the issue, or return the one already linked           | idempotent |

The skill is [`github-issues`](skills/github-issues/SKILL.md), shown as
`github-tools:github-issues` in Claude Code and `github-tools:issues` in Hermes.
An issue's kind is the organization's Issue Type of that name when it defines
one, otherwise a `type:<kind>` label.

## Reads and writes

Every read tool is named `github_<domain>_read`. Reads can run unasked; writes
are confirmed by the harness.

| Harness     | Reads without asking                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | always; the plugin asks only before a write                                                                               |
| Claude Code | the rule `mcp__plugin_github-tools_github-tools__*_read` in `permissions.allow` of `~/.claude/settings.json` or a project |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                                        |
| Grok Build  | `grok --allow 'MCPTool(github-tools__*_read)'`                                                                            |
| Antigravity | an Allow rule `mcp(github-tools/<tool>)` for each read tool; not yet verified                                             |
| Hermes      | always; the plugin asks only before a write                                                                               |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `github_*` rule shown under [OpenCode](#opencode).
- **Codex** under `codex exec`, and **Grok Build** under `grok -p`, refuse a
  write they cannot ask about, unless it is allowed beforehand.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting         | Flag              | Variable                           | Meaning                                                                                                              |
| --------------- | ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `toolsets`      | `--toolsets`      | `CRAFT_AGENT_GITHUB_TOOLSETS`      | `issues`, `pull_requests`, `projects`, `repos`, `releases`, `actions` or `all`; default `issues` and `pull_requests` |
| `read_only`     | `--read-only`     | `CRAFT_AGENT_GITHUB_READ_ONLY`     | registers no tool that writes; wins over every other setting                                                         |
| `tools`         | `--tools`         | `CRAFT_AGENT_GITHUB_TOOLS`         | single tools to add by ID, whatever their toolset                                                                    |
| `exclude_tools` | `--exclude-tools` | `CRAFT_AGENT_GITHUB_EXCLUDE_TOOLS` | single tools to remove by ID; wins over `tools` and `toolsets`                                                       |
| `confirm`       | `--confirm`       | `CRAFT_AGENT_GITHUB_CONFIRM`       | MCP server only: `harness` (default) or `elicitation`, as `docs/conventions.md` describes                            |

Lists are comma-separated in a flag or a variable. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays and
  `read_only` as a boolean.
- **Hermes** takes `plugins.entries.github-tools.settings` in `config.yaml`:

  ```yaml
  plugins:
    entries:
      github-tools:
        settings:
          toolsets: [issues, pull_requests, projects]
          read_only: false
          exclude_tools: [github_pr_merge]
  ```

- **Claude Code and Antigravity** start the plugin's server without flags; Claude
  Code passes the client's environment, so set the variables in the environment
  the harness runs in.
- **Codex and Grok Build** pass no environment to a plugin's MCP server, so the
  `CRAFT_AGENT_GITHUB_*` variables have no effect there. To change settings in Codex,
  add the server under `[mcp_servers]` in Codex's config with flags in `args` (as
  in [Any other MCP host](#any-other-mcp-host)) instead of using the plugin.

## Layout

- `src/core/` — the tools, free of any harness.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by `craft-agent-github`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `craft-agent-github-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root.
- `plugin.json`, `mcp.json`, `.mcp.json`, `.claude-plugin/`, `.agents/plugins/`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. The root `.mcp.json` is the configuration Grok Build reads
  (with `${CLAUDE_PLUGIN_ROOT}`, the variable both Grok Build and Claude Code
  expand); when working on this repository in Claude Code, decline the project
  MCP server it offers from that file.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE)
