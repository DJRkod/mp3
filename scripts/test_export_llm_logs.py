"""Tests for export_llm_logs.py.

Run with:  python -m unittest discover -s scripts -p "test_*.py"
"""
import contextlib
import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_llm_logs as exporter  # noqa: E402


def entry(uuid, kind, content, timestamp, **extra):
    record = {
        "type": kind,
        "uuid": uuid,
        "sessionId": "session-1",
        "timestamp": timestamp,
        "message": {"role": kind, "content": content},
    }
    record.update(extra)
    return record


CONVERSATION = [
    entry("u1", "user", "Build me a navbar.", "2026-09-20T10:00:00Z"),
    entry("a1", "assistant", [
        {"type": "thinking", "thinking": "private reasoning"},
        {"type": "text", "text": "Here is the plan."},
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
    ], "2026-09-20T10:00:05Z"),
    entry("u2", "user", [{"type": "tool_result", "content": "file-a\nfile-b"}], "2026-09-20T10:00:06Z"),
]


class ExporterTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.transcripts = root / "transcripts"
        self.transcripts.mkdir()
        self.output = root / "llm_logs.csv"
        self.redact_file = root / ".llm_log_redact.txt"
        self.redact_file.write_text("", encoding="utf-8")
        patches = [
            mock.patch.object(exporter, "OUTPUT", self.output),
            mock.patch.object(exporter, "REDACT_FILE", self.redact_file),
            mock.patch.object(exporter, "transcript_dir", lambda: self.transcripts),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def write_transcript(self, entries, name="session-1.jsonl"):
        lines = "\n".join(json.dumps(item) for item in entries) + "\n"
        (self.transcripts / name).write_text(lines, encoding="utf-8")

    def run_export(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["export_llm_logs.py", *args]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = exporter.main()
        return code, stdout.getvalue()

    def rows(self):
        with open(self.output, encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))


class ExportRowsTest(ExporterTestCase):
    def test_prompt_response_tool_call_and_result_become_ordered_rows(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        self.assertEqual(
            [(row["role"], row["kind"]) for row in self.rows()],
            [("user", "prompt"), ("assistant", "response"),
             ("assistant", "tool_call"), ("user", "tool_result")],
        )

    def test_thinking_blocks_are_not_exported(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        self.assertFalse(any("private reasoning" in row["content"] for row in self.rows()))

    def test_rerun_adds_no_duplicates_and_picks_up_a_dangling_response(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        first = self.rows()
        self.run_export()
        self.assertEqual(self.rows(), first)

        late = entry("a2", "assistant", [{"type": "text", "text": "Done."}], "2026-09-20T10:00:09Z")
        self.write_transcript(CONVERSATION + [late])
        self.run_export()
        rows = self.rows()
        self.assertEqual(len(rows), len(first) + 1)
        self.assertEqual(rows[-1]["content"], "Done.")

    def test_rows_survive_deletion_of_their_transcript(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        (self.transcripts / "session-1.jsonl").unlink()
        self.run_export()
        self.assertEqual(len(self.rows()), 4)

    def test_malformed_last_line_is_skipped(self):
        self.write_transcript(CONVERSATION)
        with open(self.transcripts / "session-1.jsonl", "a", encoding="utf-8") as handle:
            handle.write('{"type": "assistant", "uuid": "a9", "mess')
        self.run_export()
        self.assertEqual(len(self.rows()), 4)


class RedactionTest(ExporterTestCase):
    def test_private_email_is_redacted_and_public_one_is_kept(self):
        self.write_transcript([entry(
            "u1", "user",
            "Mail me at someone.private@example.com or uiuc.web.programming@gmail.com.",
            "2026-09-20T10:00:00Z",
        )])
        self.run_export()
        content = self.rows()[0]["content"]
        self.assertNotIn("someone.private@example.com", content)
        self.assertIn("[redacted-email]", content)
        self.assertIn("uiuc.web.programming@gmail.com", content)

    def test_listed_terms_are_scrubbed_case_insensitively(self):
        self.redact_file.write_text("secretname\n", encoding="utf-8")
        self.write_transcript([entry("u1", "user", "grep SecretName in the log", "2026-09-20T10:00:00Z")])
        self.run_export()
        content = self.rows()[0]["content"]
        self.assertNotIn("SecretName", content)
        self.assertIn("[redacted]", content)

    def test_redaction_also_covers_rows_kept_from_an_earlier_export(self):
        self.write_transcript([entry("u1", "user", "term: keepsake", "2026-09-20T10:00:00Z")])
        self.run_export()
        (self.transcripts / "session-1.jsonl").unlink()
        self.redact_file.write_text("keepsake\n", encoding="utf-8")
        self.run_export()
        self.assertNotIn("keepsake", self.rows()[0]["content"])


class RowKindTest(ExporterTestCase):
    def kinds(self):
        return [row["kind"] for row in self.rows()]

    def test_skill_text_injected_by_the_harness_is_skill_context(self):
        self.write_transcript([entry("u1", "user", [{"type": "text", "text": "# Skill body"}],
                                     "2026-09-20T10:00:00Z", isMeta=True)])
        self.run_export()
        self.assertEqual(self.kinds(), ["skill_context"])

    def test_slash_command_with_arguments_is_a_prompt(self):
        text = "<command-name>/plan</command-name>\n<command-args>Build the navbar</command-args>"
        self.write_transcript([entry("u1", "user", text, "2026-09-20T10:00:00Z")])
        self.run_export()
        self.assertEqual(self.kinds(), ["prompt"])

    def test_slash_command_without_arguments_is_a_command(self):
        text = "<command-name>/model</command-name>\n<command-args></command-args>"
        self.write_transcript([entry("u1", "user", text, "2026-09-20T10:00:00Z")])
        self.run_export()
        self.assertEqual(self.kinds(), ["command"])

    def test_subagent_rows_are_tagged(self):
        self.write_transcript([entry("a1", "assistant", [{"type": "text", "text": "Reviewing."}],
                                     "2026-09-20T10:00:00Z", isSidechain=True)])
        self.run_export()
        self.assertEqual(self.kinds(), ["subagent_response"])


class TruncationTest(ExporterTestCase):
    def long_result(self, body):
        return [entry("u1", "user", [{"type": "tool_result", "content": body}], "2026-09-20T10:00:00Z")]

    def test_long_tool_results_are_cut_with_a_marker_and_full_disables_it(self):
        self.write_transcript(self.long_result("x" * 9000))
        self.run_export()
        content = self.rows()[0]["content"]
        self.assertTrue(content.endswith("[... truncated, 9000 characters total]"))
        self.assertLess(len(content), 9000)

        self.run_export("--full")
        self.assertEqual(self.rows()[0]["content"], "x" * 9000)

    def test_long_responses_are_never_cut(self):
        self.write_transcript([entry("a1", "assistant", [{"type": "text", "text": "y" * 9000}],
                                     "2026-09-20T10:00:00Z")])
        self.run_export()
        self.assertEqual(len(self.rows()[0]["content"]), 9000)

    def test_an_email_straddling_the_cut_is_still_redacted(self):
        email = "someone.private@example.com"
        body = "x" * (exporter.DEFAULT_CAP - 12) + email + "x" * 4000
        self.write_transcript(self.long_result(body))
        self.run_export()
        content = self.rows()[0]["content"]
        self.assertNotIn("someone", content)
        self.assertNotIn("@example", content)


class ExistingLogTest(ExporterTestCase):
    def test_the_course_template_placeholder_is_replaced(self):
        self.output.write_text("example_chatgpt_log_link1\nexample_bing_chat_log_link2", encoding="utf-8")
        self.write_transcript(CONVERSATION)
        self.run_export()
        self.assertEqual(len(self.rows()), 4)

    def test_an_unrecognized_existing_file_blocks_instead_of_being_overwritten(self):
        self.output.write_text("my,own,columns\n1,2,3\n", encoding="utf-8")
        self.write_transcript(CONVERSATION)
        with self.assertRaises(ValueError):
            self.run_export()
        self.assertIn("my,own,columns", self.output.read_text(encoding="utf-8"))

    def test_an_unreadable_existing_log_blocks_instead_of_dropping_its_rows(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        before = self.output.read_bytes()
        real_open = open

        def locked(path, *args, **kwargs):
            mode = args[0] if args else kwargs.get("mode", "r")
            if Path(path) == self.output and "r" in mode:
                raise PermissionError("file is locked")
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=locked), self.assertRaises(PermissionError):
            self.run_export()
        self.assertEqual(self.output.read_bytes(), before)

    def test_hand_added_rows_without_an_id_survive_reexport_exactly_once(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        with open(self.output, "a", encoding="utf-8", newline="") as handle:
            csv.writer(handle, quoting=csv.QUOTE_ALL).writerow(
                ["", "2026-09-19T08:00:00Z", "", "gpt", "user", "prompt", "https://chat.example/share/abc"])
        self.run_export()
        self.run_export()
        manual = [row for row in self.rows() if "chat.example" in row["content"]]
        self.assertEqual(len(manual), 1)
        self.assertTrue(manual[0]["entry_id"].startswith("manual:"))
        self.assertEqual(len(self.rows()), 5)

    def test_no_temp_file_is_left_behind(self):
        self.write_transcript(CONVERSATION)
        self.run_export()
        with FailureVisibilityTest.failing_replace(self), self.assertRaises(PermissionError):
            self.run_export()
        self.assertEqual([p.name for p in self.output.parent.glob("*.tmp")], [])


class RedactionFileTest(ExporterTestCase):
    def test_a_missing_term_file_blocks_the_export(self):
        self.redact_file.unlink()
        self.write_transcript(CONVERSATION)
        with self.assertRaises(FileNotFoundError):
            self.run_export()

    def test_a_term_file_saved_with_a_bom_and_crlf_still_redacts_its_first_term(self):
        self.redact_file.write_bytes("\ufeffsecretname\r\nother\r\n".encode("utf-8"))
        self.write_transcript([entry("u1", "user", "find secretname here", "2026-09-20T10:00:00Z")])
        self.run_export()
        self.assertNotIn("secretname", self.rows()[0]["content"])


class FailureVisibilityTest(ExporterTestCase):
    def failing_replace(self):
        return mock.patch.object(exporter.os, "replace", side_effect=PermissionError("file is locked"))

    def test_a_failed_export_raises_so_the_pre_commit_hook_blocks(self):
        self.write_transcript(CONVERSATION)
        with self.failing_replace(), self.assertRaises(PermissionError):
            self.run_export()

    def test_hook_mode_reports_the_failure_as_a_system_message_and_exits_zero(self):
        self.write_transcript(CONVERSATION)
        with self.failing_replace():
            code, stdout = self.run_export("--hook")
        self.assertEqual(code, 0)
        message = json.loads(stdout)["systemMessage"]
        self.assertIn("llm_logs.csv", message)
        self.assertIn("file is locked", message)

    def test_hook_mode_is_silent_on_success(self):
        self.write_transcript(CONVERSATION)
        code, stdout = self.run_export("--hook")
        self.assertEqual((code, stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()


class SecretRedactionTest(ExporterTestCase):
    """Credentials printed by a command must not reach the published log.

    The samples are assembled from pieces so that this file holds no string
    shaped like a real credential.
    """

    SAMPLES = {
        "GitHub token": "ghp" + "_" + "A1b2C3d4" * 5,
        "GitHub fine-grained token": "github" + "_pat_" + "A1b2C3d4_" * 4,
        "Anthropic key": "sk" + "-ant-" + "api03-" + "A1b2C3d4" * 4,
        "AWS access key id": "AKIA" + "ABCDEFGHIJKLMNOP",
        "Slack token": "xoxb" + "-1234567890-" + "AbCdEfGhIjKl",
        "npm token": "npm" + "_" + "A1b2C3d4" * 5,
        "JSON web token": "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "A1b2C3d4" * 4,
    }

    def export_text(self, text):
        self.write_transcript([entry("u1", "user", text, "2026-09-20T10:00:00Z")])
        self.run_export()
        return self.rows()[0]["content"]

    def test_known_credential_shapes_are_redacted(self):
        for label, sample in self.SAMPLES.items():
            with self.subTest(label):
                content = self.export_text("token is %s, keep it safe" % sample)
                self.assertNotIn(sample, content)
                self.assertIn("[redacted-secret]", content)
                self.assertIn("keep it safe", content)

    def test_a_password_in_a_url_is_redacted_and_the_host_is_kept(self):
        content = self.export_text("clone https://someone:" + "hunter2pass" + "@example.org/repo.git")
        self.assertNotIn("hunter2pass", content)
        self.assertIn("example.org/repo.git", content)

    def test_a_private_key_block_is_redacted(self):
        block = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEow" + "A1b2C3d4" * 6 + "\n-----END " + "RSA PRIVATE KEY-----"
        content = self.export_text("key:\n%s\nend" % block)
        self.assertNotIn("MIIEow", content)
        self.assertIn("[redacted-secret]", content)

    def test_ordinary_text_is_left_alone(self):
        text = ("npm install ran; see src/api/artic.ts and commit 695d4d3. "
                "The image id is 6644829f-f292-c5c4-a73c-0356a6fdbf0d.")
        self.assertEqual(self.export_text(text), text)


class EscapedTermTest(ExporterTestCase):
    def test_a_term_with_a_quote_or_backslash_is_redacted_inside_a_tool_call(self):
        term = r'C:\Users\Some "Nick" Name'
        self.redact_file.write_text(term + "\n", encoding="utf-8")
        self.write_transcript([entry("a1", "assistant", [
            {"type": "tool_use", "name": "Bash", "input": {"command": "dir " + term}},
        ], "2026-09-20T10:00:00Z")])
        self.run_export()
        content = self.rows()[0]["content"]
        self.assertNotIn("Nick", content)
        self.assertIn("[redacted]", content)
