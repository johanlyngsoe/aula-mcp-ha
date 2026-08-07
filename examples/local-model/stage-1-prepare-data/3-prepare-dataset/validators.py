"""
Pre-filter rules for training pairs.

Importable and CLI-runnable:
    python validators.py --in ~/aula-train/raw/pairs.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class Verdict:
    ok: bool
    reason: str = ""


# --- structural validators -------------------------------------------------

REQUIRED_CHILD_SECTION_MARKERS = ["👤", "📅", "📚"]  # at least one expected per child block

UNCLOSED_TAG_RE = re.compile(
    r"<(b|i|u|s|code|pre|blockquote)>(?:(?!</\1>).)*$", re.DOTALL
)

RAW_LT_RE = re.compile(r"<(?![/!]?(?:b|i|u|s|code|pre|blockquote|a)\b)[^>]")


def validate_html(response: str) -> Verdict:
    if not response:
        return Verdict(False, "empty_response")
    if len(response) < 100:
        return Verdict(False, "response_too_short")
    # Telegram-HTML allows only a small tag whitelist; balance check on those.
    for tag in ("b", "i", "u", "s", "code", "pre", "blockquote"):
        opens = response.count(f"<{tag}>") + response.count(f"<{tag} ")
        closes = response.count(f"</{tag}>")
        if opens != closes:
            return Verdict(False, f"unbalanced_<{tag}>")
    # No raw '<' that isn't part of an allowed tag.
    if RAW_LT_RE.search(response):
        return Verdict(False, "unescaped_lt")
    # No empty blockquotes — the prompt explicitly forbids them.
    if "<blockquote></blockquote>" in response.replace("\n", "").replace(" ", ""):
        return Verdict(False, "empty_blockquote")
    # At least one child-section marker present.
    if not any(m in response for m in REQUIRED_CHILD_SECTION_MARKERS):
        return Verdict(False, "no_child_section_markers")
    return Verdict(True)


def validate_tool_calls(tool_calls: list[dict[str, Any]]) -> Verdict:
    if not tool_calls:
        return Verdict(False, "no_tool_calls")
    oks = [tc for tc in tool_calls if tc.get("ok", True)]
    if not oks:
        return Verdict(False, "all_tool_calls_failed")
    # Discover should be the first successful call when present.
    if oks[0]["tool"] != "aula.discover":
        # Not a hard fail (some scripted runs skip discover after warm cache),
        # but we treat it as a soft signal — count instead of dropping.
        pass
    # Truncated result heuristic: serialised result longer than 5 MB is implausible.
    for tc in oks:
        ser = json.dumps(tc.get("result"), default=str)
        if len(ser) > 5_000_000:
            return Verdict(False, "tool_result_unbounded")
    return Verdict(True)


def validate_pair(pair: dict[str, Any]) -> Verdict:
    if not isinstance(pair.get("prompt"), str) or len(pair["prompt"]) < 100:
        return Verdict(False, "prompt_too_short")
    v = validate_html(pair.get("response", ""))
    if not v.ok:
        return v
    v = validate_tool_calls(pair.get("tool_calls", []))
    if not v.ok:
        return v
    return Verdict(True)


# --- CLI --------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--in", dest="in_path", required=True, help="pairs.jsonl from Phase 2"
    )
    args = ap.parse_args()

    counts: dict[str, int] = {}
    with Path(args.in_path).open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                pair = json.loads(line)
            except json.JSONDecodeError:
                counts["json_error"] = counts.get("json_error", 0) + 1
                continue
            v = validate_pair(pair)
            key = "kept" if v.ok else f"dropped:{v.reason}"
            counts[key] = counts.get(key, 0) + 1

    for key in sorted(counts):
        print(f"{key:40s} {counts[key]}", file=sys.stderr)
    kept = counts.get("kept", 0)
    total = sum(counts.values())
    pct = 100 * kept / total if total else 0
    print(f"\nkeep rate: {kept}/{total}  ({pct:.1f}%)", file=sys.stderr)
    return 0 if kept > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
