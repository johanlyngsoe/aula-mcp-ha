"""
Convert joined (prompt, tool_calls[], response) pairs into MLX-LM training format.

Reads:  ~/aula-train/raw/pairs.jsonl    (from Phase 2 join-with-trace.ts)
Writes: ~/aula-train/splits/{train,valid,test}.jsonl

Each output line:
    {"text": "<|im_start|>system\n...<|im_end|>\n<|im_start|>user\n...<|im_end|>\n..."}

For Qwen2.5-3B-Instruct's native tool-call ChatML.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from validators import validate_pair  # type: ignore[import-not-found]


SYSTEM_PROMPT = (
    "Du er en assistent der laver daglige opslag på dansk om brugerens børn "
    "baseret på data fra Aula. Du kalder MCP-værktøjer fra aula-mcp for at "
    "hente data og returnerer det færdige Telegram-HTML opslag når du har det "
    "du har brug for. Send altid `compact: true` til `aula.posts.list`, "
    "`aula.messages.list_threads`, `aula.messages.get_thread` og "
    "`aula.ugeplan.*`."
)


def render_chatml(pair: dict[str, Any]) -> str:
    """Render one (prompt, tool_calls[], response) pair as Qwen2.5 ChatML text."""
    parts: list[str] = []
    parts.append(f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>")
    parts.append(f"<|im_start|>user\n{pair['prompt']}<|im_end|>")

    # Interleave assistant <tool_call> turns with <tool_response> turns.
    for tc in pair["tool_calls"]:
        if not tc.get("ok", True):
            # Skip failed calls — we don't want to teach the model that errors
            # are normal flow. validators.py already drops pairs that are
            # entirely failures; isolated mid-trace failures are simply dropped.
            continue
        call_json = json.dumps(
            {"name": tc["tool"], "arguments": tc.get("args") or {}},
            ensure_ascii=False,
        )
        result_json = json.dumps(tc.get("result"), ensure_ascii=False, default=str)
        parts.append(
            f"<|im_start|>assistant\n<tool_call>\n{call_json}\n</tool_call><|im_end|>"
        )
        parts.append(
            f"<|im_start|>tool\n<tool_response>\n{result_json}\n</tool_response><|im_end|>"
        )

    parts.append(f"<|im_start|>assistant\n{pair['response']}<|im_end|>")
    return "\n".join(parts)


def stratified_split(
    pairs: list[dict[str, Any]],
    val_frac: float,
    test_frac: float,
    seed: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Split preserving `kind` distribution."""
    rng = random.Random(seed)
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for p in pairs:
        by_kind.setdefault(p.get("kind", "unknown"), []).append(p)

    train, valid, test = [], [], []
    for kind, items in by_kind.items():
        rng.shuffle(items)
        n = len(items)
        n_test = max(1, int(round(n * test_frac))) if n >= 20 else 0
        n_val = max(1, int(round(n * val_frac))) if n >= 20 else 0
        test.extend(items[:n_test])
        valid.extend(items[n_test : n_test + n_val])
        train.extend(items[n_test + n_val :])

    rng.shuffle(train)
    rng.shuffle(valid)
    rng.shuffle(test)
    return train, valid, test


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def main() -> int:
    home = os.path.expanduser("~")
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", default=f"{home}/aula-train/raw/pairs.jsonl")
    ap.add_argument("--out", dest="out_dir", default=f"{home}/aula-train/splits")
    ap.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--test-frac", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--report-dropped",
        default=None,
        help="If set, write filtered-out pairs to this path for inspection.",
    )
    ap.add_argument(
        "--loss-mask",
        action="store_true",
        help="Emit prompt/completion schema with loss on assistant tokens only.",
    )
    args = ap.parse_args()

    in_path = Path(args.in_path)
    if not in_path.exists():
        print(f"[prepare] no input at {in_path}", file=sys.stderr)
        return 1

    raw: list[dict[str, Any]] = []
    with in_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                raw.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    drop_reasons: Counter[str] = Counter()

    for p in raw:
        verdict = validate_pair(p)
        if verdict.ok:
            kept.append(p)
        else:
            dropped.append({"conv_id": p.get("conv_id"), "reason": verdict.reason})
            drop_reasons[verdict.reason] += 1

    print(
        f"[prepare] read={len(raw)} kept={len(kept)} dropped={len(dropped)}",
        file=sys.stderr,
    )
    for reason, n in drop_reasons.most_common():
        print(f"  dropped[{reason}] = {n}", file=sys.stderr)

    if args.report_dropped:
        write_jsonl(Path(args.report_dropped), dropped)

    train, valid, test = stratified_split(
        kept, args.val_frac, args.test_frac, args.seed
    )

    def to_records(pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for p in pairs:
            text = render_chatml(p)
            if args.loss_mask:
                # Split at the final assistant turn so MLX-LM trains on completion only.
                final_marker = "<|im_start|>assistant\n"
                idx = text.rfind(final_marker)
                if idx < 0:
                    continue
                out.append({"prompt": text[: idx + len(final_marker)], "completion": text[idx + len(final_marker) :]})
            else:
                out.append({"text": text})
        return out

    out_dir = Path(args.out_dir)
    write_jsonl(out_dir / "train.jsonl", to_records(train))
    write_jsonl(out_dir / "valid.jsonl", to_records(valid))
    write_jsonl(out_dir / "test.jsonl", to_records(test))

    print(
        f"[prepare] train={len(train)} valid={len(valid)} test={len(test)} → {out_dir}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
