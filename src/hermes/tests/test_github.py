"""Tests of the package-specific Hermes toolset presentation."""

import unittest

from support import tools


class GitHubTest(unittest.TestCase):
    def test_the_six_toolsets_have_the_packages_emoji(self) -> None:
        self.assertEqual(
            tools.TOOLSET_EMOJI,
            {"issues": "🎫", "pull_requests": "🔀", "projects": "📋", "repos": "📦", "releases": "🚀", "actions": "🤖"},
        )
