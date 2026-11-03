# AGENTS

agent-github is one set of GitHub and git tools for coding agents, delivered
to several harnesses (OpenCode, Claude Code, Codex, Hermes) from this
repository. Releases are GitHub Releases tagged `v<version>`; consumers pin a
tag.

## Layout

- `src/core/` — the tools. Each is a `tool({ description, args, execute })`
  spec with a Zod v4 schema; `execute` gets a `ToolContext`.
- `src/<harness>/` — one thin entry point per harness, which turns the specs
  into that harness's tools. `src/opencode/` today; `src/mcp/` and
  `src/hermes/` (Python, import name `agent_github_hermes`) follow.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **`src/core/` knows no harness and no caller.** No harness, product or
  machine names, paths or session conventions in code, descriptions or
  messages. What differs between consumers is a setting an entry point passes
  in, with a neutral default.
- **Tool IDs are a public interface.** Permission rules and skills key on them
  (`gh_issue_create`, `git_publish`); renaming one is a breaking change.
- **Writes that leave the worktree assert first.** GitHub writes go through
  the permission gate in the context; publishing goes through a read-only
  preview whose token the write must present.

## Commands

- `pnpm test`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
