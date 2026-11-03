# agent-github

GitHub and git tools for coding agents: issues, project boards, pull requests,
commits and native stacks. One implementation, delivered to each agent
harness in the form that suits it best.

| Harness     | Delivery                                   |
| ----------- | ------------------------------------------ |
| OpenCode    | native plugin                              |
| Claude Code | plugin: MCP server and skills (planned)    |
| Codex       | plugin: MCP server and skills (planned)    |
| Hermes      | MCP server and an approval layer (planned) |

The tools need `git` and the [GitHub CLI](https://cli.github.com/),
authenticated as you.

## Layout

- `src/core/` — the tools, free of any harness.
- `src/opencode/` — the OpenCode plugin.
- `src/mcp/`, `src/hermes/` — the MCP server and the Hermes layer (planned).

## License

[MIT](LICENSE)
