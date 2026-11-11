"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "github-tools"

#: The built command-line name used in error and log messages.
CLI_NAME = "github-tools-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "github-"

#: The emoji each toolset is shown with; empty by default until a project adds its own.
TOOLSET_EMOJI: dict[str, str] = {
    "issues": "🎫",
    "pull_requests": "🔀",
    "projects": "📋",
    "repos": "📦",
    "releases": "🚀",
    "actions": "🤖",
}

__all__ = [
    "CLI_NAME",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
