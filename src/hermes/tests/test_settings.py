"""Tests of the settings the plugin turns into command-line flags."""

from __future__ import annotations

import unittest
from typing import Any

from support import StubContext, settings


class SettingsFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_no_setting_gives_no_flag(self) -> None:
        self.assertEqual(self.flags(), [])

    def test_each_setting_becomes_its_flag(self) -> None:
        self.assertEqual(
            self.flags(
                toolsets=["issues", "projects"],
                read_only=True,
                tools=["github_repo_read"],
                exclude_tools=["github_pr_merge", "github_repo_edit"],
            ),
            [
                "--toolsets",
                "issues,projects",
                "--read-only",
                "--tools",
                "github_repo_read",
                "--exclude-tools",
                "github_pr_merge,github_repo_edit",
            ],
        )

    def test_all_toolsets_as_text_or_as_a_list(self) -> None:
        self.assertEqual(self.flags(toolsets="all"), ["--toolsets", "all"])
        self.assertEqual(self.flags(toolsets=["all"]), ["--toolsets", "all"])

    def test_false_and_empty_settings_give_no_flag(self) -> None:
        self.assertEqual(self.flags(toolsets=[], read_only=False, tools=[], exclude_tools=[]), [])

    def test_a_wrong_type_is_refused(self) -> None:
        for config in (
            {"toolsets": "issues"},
            {"toolsets": 3},
            {"read_only": "true"},
            {"tools": "github_repo_read"},
            {"exclude_tools": [1]},
        ):
            with self.subTest(config=config), self.assertRaises(settings.SettingsError):
                self.flags(**config)


if __name__ == "__main__":
    unittest.main()
