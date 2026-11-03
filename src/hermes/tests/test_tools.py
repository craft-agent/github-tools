"""Tests of registering the tools and of the handler that runs one through the command line."""

from __future__ import annotations

import json
import unittest
from typing import Any
from unittest import mock

from support import CWD, FAKE_CLI, LISTING, FakeCliCase, runtime, tools


class RegisterTest(FakeCliCase):
    def test_registers_each_listed_tool(self) -> None:
        ctx = self.register()
        self.assertEqual(list(ctx.tools), [entry["id"] for entry in LISTING])
        comment = ctx.tools["github_issue_comment"]
        self.assertEqual(
            comment["schema"],
            {
                "name": "github_issue_comment",
                "description": "Description of github_issue_comment",
                "parameters": LISTING[1]["input_schema"],
            },
        )
        self.assertEqual(comment["description"], "Comment on an issue")
        self.assertTrue(callable(comment["handler"]))

    def test_groups_tools_by_toolset_with_an_emoji_each(self) -> None:
        ctx = self.register()
        self.assertEqual(
            {tool_id: (tool["toolset"], tool["emoji"]) for tool_id, tool in ctx.tools.items()},
            {
                "github_issue_read": ("agent-github-issues", "🎫"),
                "github_issue_comment": ("agent-github-issues", "🎫"),
                "github_pr_merge": ("agent-github-pull-requests", "🔀"),
                "github_project_item_add": ("agent-github-projects", "📋"),
                "github_repo_edit": ("agent-github-repos", "📦"),
                "github_release_publish": ("agent-github-releases", "🏷️"),
                "github_run_rerun": ("agent-github-actions", "⚙️"),
            },
        )

    def test_registers_the_approval_hook_on_pre_tool_call(self) -> None:
        ctx = self.register()
        self.assertEqual([name for name, _ in ctx.hooks], ["pre_tool_call"])


class HandlerTest(FakeCliCase):
    def handler(self, tool_id: str = "github_issue_comment", config: dict[str, Any] | None = None) -> Any:
        return self.register(config).tools[tool_id]["handler"]

    def run_calls(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][0] == "run"]

    def test_passes_the_arguments_on_stdin_and_the_cwd_and_flags(self) -> None:
        stdout = json.dumps({"result": {"number": 12}}) + "\n"
        self.reply("run github_issue_comment", stdout=stdout)
        handler = self.handler(config={"toolsets": ["issues"], "read_only": False, "exclude_tools": ["github_pr_merge"]})
        handler({"issue_number": 12, "body": "héllo ✓"})
        [call] = self.run_calls()
        self.assertEqual(
            call["argv"],
            ["run", "github_issue_comment", "--cwd", CWD, "--toolsets", "issues", "--exclude-tools", "github_pr_merge"],
        )
        self.assertEqual(json.loads(call["stdin"]), {"issue_number": 12, "body": "héllo ✓"})

    def test_returns_the_success_document_as_it_is(self) -> None:
        self.reply("run github_issue_comment", stdout='{"result":{"url":"https://example.test/1"}}\n')
        self.assertEqual(self.handler()({}), '{"result":{"url":"https://example.test/1"}}')

    def test_accepts_the_keyword_arguments_hermes_adds(self) -> None:
        self.reply("run github_issue_comment", stdout='{"result":{}}\n')
        self.assertEqual(self.handler()({}, task_id="t1", user_task="x"), '{"result":{}}')

    def test_maps_a_tool_error_to_code_and_message(self) -> None:
        error = {"error": {"code": "not_found", "message": "No such issue."}}
        self.reply("run github_issue_comment", stdout=json.dumps(error) + "\n", code=1)
        self.assertEqual(json.loads(self.handler()({})), {"error": "not_found: No such issue."})

    def test_maps_an_exit_without_a_document_to_its_stderr(self) -> None:
        self.reply("run github_issue_comment", stderr="agent-github: boom\n", code=2)
        self.assertEqual(json.loads(self.handler()({})), {"error": "agent-github failed: agent-github: boom"})
        self.reply("run github_issue_comment", code=3)
        self.assertEqual(json.loads(self.handler()({})), {"error": "agent-github failed: exit status 3"})

    def test_maps_a_success_that_is_not_a_result_document_to_an_error(self) -> None:
        self.reply("run github_issue_comment", stdout="garbage")
        self.assertIn("error", json.loads(self.handler()({})))

    def test_a_timeout_is_an_error_result(self) -> None:
        self.reply("run github_issue_comment", sleep=5)
        handler = self.handler()
        with mock.patch.object(tools, "RUN_TIMEOUT_SECONDS", 0.3):
            result = json.loads(handler({}))
        self.assertIn("did not finish", result["error"])

    def test_a_cli_that_cannot_start_is_an_error_result(self) -> None:
        broken = runtime.Runtime(node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        result = json.loads(tools.make_handler(broken, "github_issue_comment", [])({}))
        self.assertIn("could not be started", result["error"])

    def test_arguments_that_are_not_json_are_an_error_result(self) -> None:
        result = json.loads(self.handler()({"value": object()}))
        self.assertIn("github_issue_comment could not run", result["error"])

    def test_a_failing_cwd_lookup_is_an_error_result(self) -> None:
        handler = self.handler()
        with mock.patch.object(tools, "agent_cwd", side_effect=OSError("cwd is gone")):
            result = json.loads(handler({}))
        self.assertIn("cwd is gone", result["error"])


if __name__ == "__main__":
    unittest.main()
