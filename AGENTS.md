# AGENTS

agent-github is one set of GitHub tools for coding agents — issues, project
boards, pull requests, repositories, releases and Actions — delivered to
several harnesses (OpenCode, Claude Code, Codex, Grok Build, Antigravity,
Hermes Agent) from this repository. Releases are GitHub Releases tagged
`v<version>`; consumers pin a tag or the same npm version.

## Layout

- `src/core/` — the tools. Each is a spec with a Zod v4 argument schema, an
  output schema, a toolset and a write class; `execute` gets a `ToolContext`.
- `src/<entry>/` — one thin entry point per delivery, which turns the specs
  into that harness's tools: `src/opencode/` (native plugin), `src/mcp/`
  (the stdio MCP server the other plugins bundle), and the CLI the Hermes
  plugin (Python, import name `agent_github_hermes`) calls.
- `docs/conventions.md` — the rules every tool follows.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **Every tool follows [`docs/conventions.md`](docs/conventions.md).** A
  change to a convention changes that file first, with its reason.
- **`src/core/` knows no harness and no caller.** No harness, product or
  machine names, paths or session conventions in code, descriptions or
  messages. What differs between consumers is a setting an entry point passes
  in, with a neutral default. It uses `node:*` modules only, never a
  runtime's own globals, so it runs on Node and Bun.
- **Tool IDs are a public interface.** Permission rules and skills key on them
  (`github_issue_create`); renaming one is a breaking change.
- **A tool's write class is its contract with the harness.** The class sets
  the annotations every entry point publishes, so it must be the strictest
  class the tool's arguments can reach. `read_only` registers no write tool;
  annotations are hints, never the boundary.
- **Every `gh` call goes through the one runner**, which fixes a
  non-interactive environment and maps failures to error codes.

## Commands

- `pnpm test`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
