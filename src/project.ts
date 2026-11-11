/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "github-tools",
  /** The command line the Hermes plugin calls. */
  cli: "github-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "github",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "GITHUB_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["issues", "pull_requests", "projects", "repos", "releases", "actions"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["issues", "pull_requests", "projects"] as readonly string[],
  /** The environment variables the tools read besides the settings, which Codex forwards to the server after them. */
  toolVariables: [] as readonly string[],
} as const
