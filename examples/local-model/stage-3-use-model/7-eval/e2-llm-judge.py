"""
E2 — LLM-as-judge eval.

For each (input, gold-Gemini-response, candidate-local-response), send the
triple to a stronger model and ask for a 1-5 semantic-equivalence score plus
notes on factual omissions or hallucinations.

Aggregate: gate on mean ≥ 4.0  AND  min ≥ 3.

Cost: ~€2-5 on Gemini paid tier for n=30.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


JUDGE_PROMPT = """Du er en streng dansk evaluator. Sammenlign 'kandidaten' med 'gold' nedenfor.

VURDERING (1-5):
  5 = semantisk identiske; intet faktuelt mistet eller forkert
  4 = lille stilistisk forskel; al substans bevaret
  3 = mindre faktuel udeladelse eller upræcis formulering
  2 = vigtigt faktum mangler eller er forkert
  1 = direkte vildledende eller helt off-topic

INDHOLD AT BEDØMME:
  - Er alle børn dækket?
  - Er der nye fakta i kandidaten der ikke står i gold (hallucination)?
  - Er der fakta i gold der mangler i kandidaten (udeladelse)?
  - Er aktioner ("kræver svar", "husk ...") bevaret?
  - Er forkerte køn/navne brugt? (vigtigt!)
  - Er datoer/tider rigtige?

Returnér KUN denne JSON (intet andet):
{"score": <1-5>, "issues": ["..."]}

--- GOLD ---
{gold}

--- KANDIDAT ---
{candidate}
"""


def parse_e1_samples(path: str) -> list[dict[str, str]]:
    """Parse e1-structural.py's sample dump back into per-example records."""
    records: list[dict[str, str]] = []
    text = Path(path).read_text(encoding="utf-8")
    blocks = text.split("=== example ")
    for block in blocks[1:]:
        try:
            after_header = block.split("\n", 1)[1]
            cand_marker = "--- candidate ---\n"
            gold_marker = "\n--- gold ---\n"
            ci = after_header.index(cand_marker) + len(cand_marker)
            gi = after_header.index(gold_marker)
            candidate = after_header[ci:gi].strip()
            gold = after_header[gi + len(gold_marker) :].strip()
            records.append({"candidate": candidate, "gold": gold})
        except (ValueError, IndexError):
            continue
    return records


def call_judge(model: str, prompt: str) -> dict[str, Any]:
    """Call the judge model. Falls back gracefully if API libraries missing."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise SystemExit("set GEMINI_API_KEY in env")

    try:
        from google import genai  # type: ignore
    except ImportError:
        raise SystemExit(
            "google-genai not installed: pip install google-genai"
        )

    client = genai.Client(api_key=key)
    resp = client.models.generate_content(model=model, contents=prompt)
    text = resp.text or ""
    # Best-effort JSON extraction.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        return {"score": 0, "issues": ["judge_returned_non_json"], "raw": text}
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {"score": 0, "issues": ["judge_returned_invalid_json"], "raw": text}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate-from", required=True, help="e1-samples.txt")
    ap.add_argument("--gold-from", required=True, help="splits/test.jsonl (for ts/kind metadata)")
    ap.add_argument("--report", required=True)
    ap.add_argument("--judge", default="gemini-2.0-flash")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--delay", type=float, default=1.0)
    args = ap.parse_args()

    pairs = parse_e1_samples(args["candidate_from"] if isinstance(args, dict) else args.candidate_from)
    pairs = pairs[: args.n]
    if not pairs:
        print("no parseable pairs in candidate file", file=sys.stderr)
        return 1

    results: list[dict[str, Any]] = []
    for i, p in enumerate(pairs, 1):
        prompt = JUDGE_PROMPT.format(gold=p["gold"][:8000], candidate=p["candidate"][:8000])
        try:
            verdict = call_judge(args.judge, prompt)
        except Exception as e:  # noqa: BLE001
            verdict = {"score": 0, "issues": [f"judge_error:{type(e).__name__}:{e}"]}
        results.append({"i": i, **verdict})
        sc = verdict.get("score", "?")
        print(f"[e2] {i:3d}/{len(pairs)} score={sc}", file=sys.stderr)
        time.sleep(args.delay)

    scores = [r["score"] for r in results if isinstance(r.get("score"), (int, float)) and r["score"] > 0]
    mean = sum(scores) / len(scores) if scores else 0.0
    mn = min(scores) if scores else 0.0
    pct = sum(1 for s in scores if s >= 4) / len(scores) if scores else 0.0
    report = {
        "judge": args.judge,
        "n": len(results),
        "n_scored": len(scores),
        "mean": mean,
        "min": mn,
        "pct_at_4_or_above": pct,
        "results": results,
    }
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    gate_passes = mean >= 4.0 and mn >= 3
    print(
        f"\n[e2] mean={mean:.2f}  min={mn}  ≥4: {100*pct:.0f}%  → "
        f"{'PASS' if gate_passes else 'FAIL'}",
        file=sys.stderr,
    )
    return 0 if gate_passes else 2


if __name__ == "__main__":
    raise SystemExit(main())
