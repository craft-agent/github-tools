# agent-github

GitHub tools for coding agents: issues, project boards, pull requests,
repositories, releases and Actions. One implementation, delivered to each
agent harness in the form that suits it best.

| Harness      | Delivery                                |
| ------------ | --------------------------------------- |
| OpenCode     | native plugin (planned)                 |
| Hermes Agent | native plugin (planned)                 |
| Claude Code  | plugin: MCP server and skills (planned) |
| Codex        | plugin: MCP server and skills (planned) |
| Grok Build   | plugin: MCP server and skills (planned) |
| Antigravity  | plugin: MCP server and skills (planned) |

The tools need the [GitHub CLI](https://cli.github.com/), authenticated as
you. [`docs/conventions.md`](docs/conventions.md) describes how they are
named and how they behave.

## Layout

- `src/core/` — the tools, free of any harness.
- `src/opencode/`, `src/mcp/` and the Hermes plugin — the entry points
  (planned).

## License

[MIT](LICENSE)
