"""Tests of the hook that sends calls that write to the person's approval."""

from __future__ import annotations

import json
import re
import unittest
from typing import Any
from unittest import mock

from support import CWD, FAKE_CLI, LISTING, FakeCliCase, approval, listing, runtime


class ApprovalHookTest(FakeCliCase):
    def hook(self) -> Any:
        return self.register().hooks[0][1]

    def target_calls(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][0] == "target"]

    def test_a_write_is_sent_to_approval_with_message_and_rule_key(self) -> None:
        self.reply("target github_issue_comment", stdout='{"resources":["octo/hello"]}\n')
        decision = self.hook()(tool_name="github_issue_comment", args={"repo": "Octo/Hello", "body": "hi"}, task_id="t")
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": "Comment on an issue on octo/hello (github_issue_comment)",
                "rule_key": "agent-github:github_issue_comment:octo/hello",
            },
        )
        [call] = self.target_calls()
        self.assertEqual(call["argv"], ["target", "github_issue_comment", "--cwd", CWD])
        self.assertEqual(json.loads(call["stdin"]), {"repo": "Octo/Hello", "body": "hi"})

    def test_every_non_read_class_is_sent_to_approval(self) -> None:
        for tool_id in ("github_pr_merge", "github_project_item_add", "github_repo_edit", "github_run_rerun"):
            self.reply(f"target {tool_id}", stdout='{"resources":["octo/hello"]}')
            with self.subTest(tool=tool_id):
                self.assertEqual(self.hook()(tool_name=tool_id, args={})["action"], "approve")

    def test_a_read_is_left_alone_without_asking_the_cli(self) -> None:
        self.assertIsNone(self.hook()(tool_name="github_issue_read", args={}))
        self.assertEqual(self.target_calls(), [])

    def test_a_tool_of_another_plugin_is_left_alone(self) -> None:
        self.assertIsNone(self.hook()(tool_name="write_file", args={"path": "/tmp/x"}))
        self.assertEqual(self.target_calls(), [])

    def test_every_repository_a_write_names_is_in_the_message_and_the_rule_key(self) -> None:
        self.reply("target github_issue_comment", stdout='{"resources":["octo/hello","other/repo"]}')
        decision = self.hook()(tool_name="github_issue_comment", args={"issue": "other/repo#2", "body": "hi"})
        self.assertEqual(decision["message"], "Comment on an issue on octo/hello, other/repo (github_issue_comment)")
        self.assertEqual(decision["rule_key"], "agent-github:github_issue_comment:octo/hello,other/repo")

    def assert_single_use(self, tool_id: str, key_prefix: str, **call: Any) -> dict[str, str]:
        """The decision's rule_key is the prefix plus a token no other call shares, so an "always" reuses nothing."""
        hook = self.hook()
        first = hook(tool_name=tool_id, **call)
        second = hook(tool_name=tool_id, **call)
        for decision in (first, second):
            self.assertRegex(decision["rule_key"], rf"^{re.escape(key_prefix)}:once-[0-9a-f]{{32}}$")
        self.assertNotEqual(first["rule_key"], second["rule_key"])
        return first

    def test_an_unresolved_target_is_any_resource_and_leaves_nothing_to_reuse(self) -> None:
        self.reply("target github_pr_merge", stdout='{"resources":["*"]}')
        decision = self.assert_single_use("github_pr_merge", "agent-github:github_pr_merge:*", args={})
        self.assertEqual(decision["message"], "Merge a pull request (github_pr_merge)")

    def test_a_resource_that_cannot_be_told_stays_beside_the_others_and_leaves_nothing_to_reuse(self) -> None:
        self.reply("target github_pr_merge", stdout='{"resources":["octo/hello","*"]}')
        decision = self.assert_single_use("github_pr_merge", "agent-github:github_pr_merge:octo/hello,*", args={})
        self.assertEqual(decision["message"], "Merge a pull request on octo/hello, * (github_pr_merge)")

    def test_a_rule_key_that_names_only_known_repositories_is_stable(self) -> None:
        self.reply("target github_issue_comment", stdout='{"resources":["octo/hello"]}')
        hook = self.hook()
        keys = {hook(tool_name="github_issue_comment", args={})["rule_key"] for _ in range(2)}
        self.assertEqual(keys, {"agent-github:github_issue_comment:octo/hello"})

    def test_a_failing_target_falls_back_to_any_resource(self) -> None:
        for fields in (
            {"code": 1, "stdout": '{"error":{"code":"invalid_argument","message":"x"}}'},
            {"code": 2, "stderr": "usage"},
            {"code": 0, "stdout": "not json"},
            {"code": 0, "stdout": "[]"},
            {"code": 0, "stdout": '{"resources": "octo/hello"}'},
            {"code": 0, "stdout": '{"resources": []}'},
            {"code": 0, "stdout": '{"resources": [3]}'},
            {"code": 0, "stdout": '{"resources": ["octo/hello", ""]}'},
            {"code": 0, "stdout": '{"resource": "octo/hello"}'},
        ):
            self.reply("target github_pr_merge", **fields)
            with self.subTest(fields=fields):
                self.assert_single_use("github_pr_merge", "agent-github:github_pr_merge:*", args={})

    def test_a_target_that_times_out_or_cannot_start_falls_back_to_any_resource(self) -> None:
        self.reply("target github_pr_merge", sleep=5, stdout='{"resources":["octo/hello"]}')
        hook = self.hook()
        with mock.patch.object(approval, "TARGET_TIMEOUT_SECONDS", 0.3):
            decision = hook(tool_name="github_pr_merge", args={})
        self.assertRegex(decision["rule_key"], r"^agent-github:github_pr_merge:\*:once-[0-9a-f]{32}$")
        broken = runtime.Runtime(node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        tool = listing.ToolInfo.from_listing(LISTING[2])
        decision = approval.make_hook(broken, [tool])(tool_name="github_pr_merge", args={})
        self.assertRegex(decision["rule_key"], r"^agent-github:github_pr_merge:\*:once-[0-9a-f]{32}$")

    def test_arguments_that_are_not_a_dict_still_ask(self) -> None:
        self.reply("target github_pr_merge", stdout='{"resources":["octo/hello"]}')
        decision = self.hook()(tool_name="github_pr_merge", args=None)
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(json.loads(self.target_calls()[0]["stdin"]), {})

    def test_it_does_not_look_for_a_person_itself(self) -> None:
        self.reply("target github_pr_merge", stdout='{"resources":["octo/hello"]}')
        with mock.patch.dict("os.environ", {"HERMES_CRON": "1", "HERMES_YOLO_MODE": "1"}):
            self.assertEqual(self.hook()(tool_name="github_pr_merge", args={})["action"], "approve")


if __name__ == "__main__":
    unittest.main()
