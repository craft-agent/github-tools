"""Tests of registering the tools and of the handler that runs one through the command line."""

from __future__ import annotations

import json
import unittest
from typing import Any
from unittest import mock

from support import CWD, FAKE_CLI, LISTING, FakeCliCase, approval as approval_module, runtime, tools

PIN = "ab12" * 16


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
                "github_issue_read": ("github-tools-issues", "🎫"),
                "github_issue_comment": ("github-tools-issues", "🎫"),
                "github_pr_merge": ("github-tools-pull-requests", "🔀"),
                "github_project_item_add": ("github-tools-projects", "📋"),
                "github_repo_edit": ("github-tools-repos", "📦"),
                "github_release_publish": ("github-tools-releases", "🏷️"),
                "github_run_rerun": ("github-tools-actions", "⚙️"),
            },
        )

    def test_registers_the_approval_hook_on_pre_tool_call(self) -> None:
        ctx = self.register()
        self.assertEqual([name for name, _ in ctx.hooks], ["pre_tool_call", "pre_tool_call"])


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

    def test_appends_a_tool_error_s_details_as_json_on_its_own_line(self) -> None:
        details = {"problems": [{"field": "name", "reason": "空"}]}
        stdout = (
            '{"error":{"code":"invalid_argument","message":"The thing has problems.",'
            '"details":{"problems":[{"field":"name","reason":"空"}]}}}\n'
        )
        self.reply("run github_issue_comment", stdout=stdout, code=1)
        result = json.loads(self.handler()({}))
        message, details_line = result["error"].split("\n", 1)
        self.assertEqual(message, "invalid_argument: The thing has problems.")
        self.assertEqual(json.loads(details_line), details)
        self.assertEqual(details_line, '{"problems":[{"field":"name","reason":"空"}]}')

    def test_ignores_details_that_are_not_an_object(self) -> None:
        for details in (["problem"], "problem"):
            error = {"error": {"code": "not_found", "message": "No such thing.", "details": details}}
            self.reply("run github_issue_comment", stdout=json.dumps(error) + "\n", code=1)
            self.assertEqual(json.loads(self.handler()({})), {"error": "not_found: No such thing."})

    def test_maps_an_exit_without_a_document_to_its_stderr(self) -> None:
        self.reply("run github_issue_comment", stderr="github-tools-cli: boom\n", code=2)
        self.assertEqual(json.loads(self.handler()({})), {"error": "github-tools-cli failed: github-tools-cli: boom"})
        self.reply("run github_issue_comment", code=3)
        self.assertEqual(json.loads(self.handler()({})), {"error": "github-tools-cli failed: exit status 3"})

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
        broken = runtime.Runtime(
            node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir, find_node=lambda: None
        )
        result = json.loads(tools.make_handler(broken, "github_issue_comment", [])({}))
        self.assertIn("could not be started", result["error"])

    def test_arguments_that_are_not_json_are_an_error_result(self) -> None:
        result = json.loads(self.handler()({"value": object()}))
        self.assertIn("github_issue_comment could not run", result["error"])

    def test_a_pin_is_taken_out_of_the_arguments_and_passed_as_a_flag(self) -> None:
        self.reply("run github_issue_comment", stdout='{"result":{}}')
        self.handler()({"name": "a", approval_module.PIN_ARGUMENT: PIN})
        [call] = self.run_calls()
        self.assertEqual(call["argv"], ["run", "github_issue_comment", "--cwd", CWD, f"--pin={PIN}"])
        self.assertEqual(json.loads(call["stdin"]), {"name": "a"})

    def test_an_empty_or_junk_pin_is_taken_out_and_passes_no_flag(self) -> None:
        self.reply("run github_issue_comment", stdout='{"result":{}}')
        handler = self.handler()
        for junk in ("", "ABC", PIN.upper(), PIN + "0", 5, None, ["x"]):
            with self.subTest(junk=junk):
                self.log.unlink(missing_ok=True)
                handler({"name": "a", approval_module.PIN_ARGUMENT: junk})
                [call] = self.run_calls()
                self.assertEqual(call["argv"], ["run", "github_issue_comment", "--cwd", CWD])
                self.assertEqual(json.loads(call["stdin"]), {"name": "a"})

    def test_without_the_key_it_runs_as_before(self) -> None:
        self.reply("run github_issue_comment", stdout='{"result":{}}')
        args = {"name": "a"}
        self.handler()(args)
        [call] = self.run_calls()
        self.assertEqual(call["argv"], ["run", "github_issue_comment", "--cwd", CWD])
        self.assertEqual(args, {"name": "a"})

    def test_a_stale_error_reaches_the_model_like_other_errors(self) -> None:
        error = {"error": {"code": "stale", "message": "The call changed after it was approved."}}
        self.reply("run github_issue_comment", stdout=json.dumps(error) + "\n", code=1)
        result = self.handler()({approval_module.PIN_ARGUMENT: PIN})
        self.assertEqual(json.loads(result), {"error": "stale: The call changed after it was approved."})

    def test_a_failing_cwd_lookup_is_an_error_result(self) -> None:
        handler = self.handler()
        with mock.patch.object(tools, "agent_cwd", side_effect=OSError("cwd is gone")):
            result = json.loads(handler({}))
        self.assertIn("cwd is gone", result["error"])


if __name__ == "__main__":
    unittest.main()
