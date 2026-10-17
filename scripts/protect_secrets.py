#!/usr/bin/env python3
"""Add every secret value from the gitignored credential files to the LLM log
redaction list, so that llm_logs.csv (committed to a public repo) never contains
them even if a command prints them.

Reads KEY=VALUE lines from .env and .atlas_api_keys (whichever exist) and appends
each VALUE (and each password embedded in a URL) to .llm_log_redact.txt. Prints
nothing but counts, so running it is safe to log.

Usage: python scripts/protect_secrets.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [ROOT / ".env", ROOT / ".atlas_api_keys", ROOT / ".render_api_key"]
REDACT = ROOT / ".llm_log_redact.txt"
URL_CRED = re.compile(r"://([^\s/:@]+):([^\s/@]+)@")
# Placeholder values from the course template are not secrets.
SKIP = {"", "secret-starter-mern", "<password>", "<username>"}


def values():
    for path in SOURCES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            _, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            if value in SKIP or len(value) < 8:
                continue
            for match in URL_CRED.finditer(value):
                yield match.group(2)
            if "://" not in value:
                yield value


def main():
    existing = REDACT.read_text(encoding="utf-8-sig").splitlines() if REDACT.exists() else []
    known = {t.strip() for t in existing}
    new = [v for v in dict.fromkeys(values()) if v not in known]
    if new:
        with open(REDACT, "a", encoding="utf-8") as handle:
            if existing and not existing[-1].endswith("\n"):
                handle.write("\n")
            handle.write("\n".join(new) + "\n")
    print("protect_secrets: %d term(s) already listed, %d added" % (len(known), len(new)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
