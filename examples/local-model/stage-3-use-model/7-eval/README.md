# Phase 7 — Evaluation gate

The cutover strategy (D3) drops Gemini in production, so the model must be proven before the switch. Four layers:

| Layer | What | When | Pass criterion |
|---|---|---|---|
| **E1 structural** | Tool-call grammar + final HTML validator on held-out `test.jsonl` | Every fuse | ≥95 % grammar, ≥95 % HTML |
| **E2 LLM-as-judge** | Stronger model rates outputs vs gold Gemini responses | Every release candidate | Mean ≥4.0 / min ≥3 on 30 examples |
| **E3 shadow week** | Dual-rail: Gemini → Telegram, Ollama → private channel | Once, before first cutover | You personally accept 5 consecutive days |
| **E4 production canary** | Pass-rate sensor + auto-rollback automation | Continuously after cutover | Validator < 90 % triggers revert |

## Files

- [e1-structural.py](./e1-structural.py) — runs `test.jsonl` through the fused model (or a GGUF via llama.cpp), computes loss + grammar + HTML pass rates.
- [e2-llm-judge.py](./e2-llm-judge.py) — feeds (input, gold, candidate) triples to Gemini-as-judge, aggregates scores.
- [e3-shadow-week.md](./e3-shadow-week.md) — Node-RED recipe to dual-rail Gemini + Ollama for 5-7 days.
- [e4-canary.yaml](./e4-canary.yaml) — HA automation that flips the agent_id back to Gemini on validator failure + pings you.

## Run

```bash
cd examples/local-model/7-eval

# E1 — automatic, fast (~5-10 min on fused model)
python e1-structural.py \
  --model ~/aula-train/fused-model \
  --test ~/aula-train/splits/test.jsonl \
  --out ~/aula-train/eval/e1-samples.txt \
  --report ~/aula-train/eval/e1-report.json
# Gate: grammar_pass / n  ≥ 0.95  AND  html_pass / n  ≥ 0.95

# Also run E1 against the quantized GGUF to catch quant regressions
python e1-structural.py \
  --backend llama-cpp \
  --model ~/aula-train/gguf/model-q4_k_m.gguf \
  --test ~/aula-train/splits/test.jsonl \
  --out ~/aula-train/eval/e1-q4-samples.txt \
  --report ~/aula-train/eval/e1-q4-report.json
# Pass rates should be within 1-2 % of the fused-model result.

# E2 — costs ~€2-5 on Gemini paid tier
export GEMINI_API_KEY=...
python e2-llm-judge.py \
  --candidate-from ~/aula-train/eval/e1-samples.txt \
  --gold-from ~/aula-train/splits/test.jsonl \
  --n 30 \
  --judge gemini-2.0-flash \
  --report ~/aula-train/eval/e2-report.json
# Gate: mean ≥ 4.0  AND  min ≥ 3

# E3 — see e3-shadow-week.md (manual, runs 5-7 days)

# E4 — install once after cutover:
cp e4-canary.yaml /config/automations/aula-canary.yaml
# Then reload HA automations.
```

## What each layer catches

| Layer | Catches | Misses |
|---|---|---|
| E1 | Malformed HTML, hallucinated tool names, missing required args, missing child sections | Wrong facts that happen to be well-formed |
| E2 | Semantically wrong-but-plausible outputs ("din søn" when child is a daughter; wrong day named; cancelled event reported as happening) | Subtle stylistic regressions; new failure modes the judge isn't asked about |
| E3 | Things only you notice as the parent who reads these every morning (preferred tone, what counts as "actionable", missing kids) | Anything you happen to overlook during the 5 days |
| E4 | Real-time drift after cutover | Slow degradation under the validator threshold |

Don't skip layers. They aren't redundant.
