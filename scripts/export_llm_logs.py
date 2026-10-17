#!/usr/bin/env python3
"""Rebuild llm_logs.csv from the Claude Code session transcripts for this repo.

Claude Code records every session as JSONL under
~/.claude/projects/<slug-of-repo-path>/. This script flattens those transcripts
into llm_logs.csv (one row per prompt, response, tool call, and tool result).

It is idempotent: every run re-reads all transcripts, so a response that was
still being written during the previous run ("dangling") is picked up by the
next one. Rows already in the CSV whose transcript has since been deleted are
kept.

Usage:
    python scripts/export_llm_logs.py            # regenerate llm_logs.csv
    python scripts/export_llm_logs.py --full     # do not truncate long tool output
    python scripts/export_llm_logs.py --hook     # for Claude Code hooks: report failures, never raise
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "llm_logs.csv"
FIELDS = ["entry_id", "timestamp", "session_id", "model", "role", "kind", "content"]
# Bulky, machine-generated kinds are capped; prompts, responses and tool calls
# (which hold the generated code) are always logged in full.
CAPPED_KINDS = {"tool_result", "skill_context"}
DEFAULT_CAP = 5000
# The log is committed to a public repo. Literal terms listed one per line in
# this gitignored file are scrubbed from every row on every run, as is any
# email address not in the allowlist of addresses that are already public.
REDACT_FILE = REPO_ROOT / ".llm_log_redact.txt"
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
PUBLIC_EMAILS = {"uiuc.web.programming@gmail.com", "noreply@anthropic.com", "git@github.com"}
# Credentials a command might print. A false match only replaces text in a log,
# so these lean towards matching.
SECRET = re.compile("|".join([
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    r"\bgh[pousr]_[A-Za-z0-9]{20,}",
    r"\bgithub_pat_[A-Za-z0-9_]{20,}",
    r"\bsk-ant-[A-Za-z0-9_-]{10,}",
    r"\bsk-[A-Za-z0-9]{32,}",
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
    r"\bnpm_[A-Za-z0-9]{30,}",
    r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
]), re.DOTALL)
# user:password@host in a URL; the scheme and host are kept.
URL_CREDENTIALS = re.compile(r"(?<=://)[^\s/:@]+:[^\s/@]+(?=@)")

csv.field_size_limit(2**31 - 1)


def transcript_dir():
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(REPO_ROOT))
    return Path.home() / ".claude" / "projects" / slug


def block_text(block):
    """Text of a tool_result block, whose content is a string or a block list."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(item.get("text") or "[%s]" % item.get("type", "non-text"))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    return "" if content is None else json.dumps(content, ensure_ascii=False)


def user_kind(text, is_meta):
    if is_meta:
        return "skill_context"
    if re.search(r"<command-args>\s*[^<\s]", text):
        return "prompt"  # slash command carrying the user's actual request
    if text.lstrip().startswith(("<command-", "<local-command-")):
        return "command"
    return "prompt"


def rows_from_entry(entry):
    """Yield (suffix, role, kind, content) for one transcript line."""
    message = entry.get("message")
    if entry.get("type") not in ("user", "assistant") or not isinstance(message, dict):
        return
    role = entry["type"]
    is_meta = bool(entry.get("isMeta"))
    content = message.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    for index, block in enumerate(content or []):
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            text = block.get("text", "")
            row_kind = "response" if role == "assistant" else user_kind(text, is_meta)
        elif kind == "tool_use":
            text = "%s %s" % (
                block.get("name", "?"),
                json.dumps(block.get("input", {}), ensure_ascii=False),
            )
            row_kind = "tool_call"
        elif kind == "tool_result":
            text = block_text(block)
            row_kind = "tool_result"
        else:  # thinking blocks etc. are not part of the visible exchange
            continue
        if text.strip():
            yield index, role, row_kind, text


def read_transcripts(cap, redact):
    rows = {}
    directory = transcript_dir()
    for path in sorted(directory.rglob("*.jsonl")) if directory.is_dir() else []:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue  # partially written last line; next run picks it up
                if not isinstance(entry, dict):
                    continue
                model = (entry.get("message") or {}).get("model", "") if isinstance(
                    entry.get("message"), dict) else ""
                for index, role, kind, text in rows_from_entry(entry):
                    if entry.get("isSidechain"):
                        kind = "subagent_" + kind
                    # Redact first: an address cut in half by the cap below would no
                    # longer match, and its first half would be published.
                    text = redact(text)
                    if cap and kind.replace("subagent_", "") in CAPPED_KINDS and len(text) > cap:
                        text = "%s\n[... truncated, %d characters total]" % (text[:cap], len(text))
                    entry_id = "%s:%d" % (entry.get("uuid", ""), index)
                    rows[entry_id] = {
                        "entry_id": entry_id,
                        "timestamp": entry.get("timestamp", ""),
                        "session_id": entry.get("sessionId", path.stem),
                        "model": model,
                        "role": role,
                        "kind": kind,
                        "content": text,
                    }
    return rows


def build_redactor():
    # Fail closed: without the term file, rows rebuilt from transcripts would be
    # written to a public repo unscrubbed, and nothing would look wrong.
    if not REDACT_FILE.exists():
        raise FileNotFoundError(
            "%s is missing; create it (one term per line, empty if there is nothing to redact)"
            % REDACT_FILE.name)
    # utf-8-sig: Windows Notepad saves with a BOM, which would otherwise glue
    # itself to the first term and stop it matching.
    terms = [line.strip() for line in REDACT_FILE.read_text(encoding="utf-8-sig").splitlines()]
    literal = None
    if any(terms):
        # Tool calls are logged as JSON, where quotes and backslashes are
        # escaped, so each term is matched in that form as well.
        forms = set()
        for term in filter(None, terms):
            forms.add(term)
            forms.add(json.dumps(term, ensure_ascii=False)[1:-1])
        ordered = sorted(forms, key=len, reverse=True)
        literal = re.compile("|".join(re.escape(t) for t in ordered), re.IGNORECASE)

    def redact(text):
        # Before emails: the password half of user:password@host looks like one.
        text = URL_CREDENTIALS.sub("[redacted-secret]", text)
        text = SECRET.sub("[redacted-secret]", text)
        text = EMAIL.sub(
            lambda m: m.group(0) if m.group(0).lower() in PUBLIC_EMAILS else "[redacted-email]", text)
        return literal.sub("[redacted]", text) if literal else text

    return redact


def is_template_placeholder(fieldnames):
    """The course template ships llm_logs.csv as bare example lines, or empty."""
    return not fieldnames or (len(fieldnames) == 1 and fieldnames[0].startswith("example_"))


def read_existing():
    """Rows already in the log. Read errors propagate on purpose: treating an
    unreadable log as empty would silently drop every row whose transcript is
    gone, and the export would still report success."""
    if not OUTPUT.exists():
        return {}
    rows = {}
    with open(OUTPUT, encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != FIELDS:
            if is_template_placeholder(reader.fieldnames):
                return {}
            raise ValueError("%s has unexpected columns %s; refusing to overwrite it"
                             % (OUTPUT.name, reader.fieldnames))
        for raw in reader:
            row = {field: raw.get(field) or "" for field in FIELDS}
            if not row["entry_id"]:
                # A row added by hand, for example a chat link from another LLM
                # tool. Give it a stable id so it survives every later export.
                seed = "%s|%s" % (row["timestamp"], row["content"])
                row["entry_id"] = "manual:" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]
            rows[row["entry_id"]] = row
    return rows


def export(args):
    redact = build_redactor()
    rows = read_existing()
    rows.update(read_transcripts(0 if args.full else args.cap, redact))
    ordered = sorted(rows.values(), key=lambda row: (row["timestamp"], row["entry_id"]))
    # Second pass: rows kept from earlier exports must honor terms added since.
    for row in ordered:
        row["content"] = redact(row["content"])

    # One temp file per process: a Claude Code hook and a git commit can run
    # this at the same moment, and they must not write into each other's file.
    temp = OUTPUT.with_name("%s.%d.tmp" % (OUTPUT.name, os.getpid()))
    try:
        with open(temp, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS, quoting=csv.QUOTE_ALL)
            writer.writeheader()
            writer.writerows(ordered)
        # The repo lives in Dropbox, which briefly locks a file it is syncing;
        # on Windows that makes the replace fail, so retry for a few seconds.
        for attempt in range(20):
            try:
                os.replace(temp, OUTPUT)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.25)
    finally:
        temp.unlink(missing_ok=True)
    return len(ordered)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--full", action="store_true", help="never truncate content")
    parser.add_argument("--cap", type=int, default=DEFAULT_CAP,
                        help="max characters for tool results / skill context")
    parser.add_argument("--hook", action="store_true",
                        help="Claude Code hook mode: never fail the hook, but report an "
                             "export failure to the user as a system message")
    args = parser.parse_args()

    if not args.hook:
        # A failure here raises, so the git pre-commit hook blocks the commit.
        count = export(args)
        print("llm_logs.csv: %d rows from %s" % (count, transcript_dir()), file=sys.stderr)
        if not any(transcript_dir().rglob("*.jsonl")):
            # Not an error: on a machine where Claude Code was never used for this
            # repo there is nothing new to log, and the existing rows are kept.
            print("warning: no Claude Code transcripts found there; the log was left as it was",
                  file=sys.stderr)
        return 0

    try:
        export(args)
    except Exception as error:  # a stale log must be visible, never silent
        print(json.dumps({"systemMessage": "llm_logs.csv export failed: %s: %s"
                                           % (type(error).__name__, error)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
