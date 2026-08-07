# Phase 3 — Prepare the training dataset

Convert `pairs.jsonl` (Phase 2 output) into MLX-LM's training format: one JSON object per line, each containing the full Qwen2.5 ChatML conversation with `<tool_call>...</tool_call>` and `<tool_response>...</tool_response>` blocks.

## Files

- [prepare.py](./prepare.py) — main renderer. Reads `pairs.jsonl`, emits `splits/{train,valid,test}.jsonl` stratified by `kind`.
- [validators.py](./validators.py) — pre-filters pairs whose final HTML or tool-call sequence is malformed. Used by `prepare.py`; importable for manual sanity checks.

## Run

```bash
cd examples/local-model/3-prepare-dataset

# Default paths from config/.env (RAW_DIR + SPLITS_DIR).
python prepare.py

# Or pass paths explicitly:
python prepare.py \
  --in ~/aula-train/raw/pairs.jsonl \
  --out ~/aula-train/splits \
  --model Qwen/Qwen2.5-3B-Instruct \
  --val-frac 0.05 --test-frac 0.05 \
  --seed 42
```

Output:

```
~/aula-train/splits/
├── train.jsonl   # ~90 %
├── valid.jsonl   # ~5 %
└── test.jsonl    # ~5 %  ← held-out for E1 evaluation, never seen in training
```

## What each line looks like

MLX-LM's `lora --train` expects each line to be a chat-formatted object. We emit Qwen2.5's native ChatML so the tool-call grammar matches Ollama's expectation at inference time.

```json
{
  "text": "<|im_start|>system\nDu er en assistent...<|im_end|>\n<|im_start|>user\nAnalysér data fra Aula...<|im_end|>\n<|im_start|>assistant\n<tool_call>\n{\"name\": \"aula.discover\", \"arguments\": {}}\n</tool_call><|im_end|>\n<|im_start|>tool\n<tool_response>\n{\"children\":[...]}\n</tool_response><|im_end|>\n<|im_start|>assistant\n<tool_call>\n{\"name\": \"aula.messages.list_threads\", \"arguments\": {\"pageSize\": 20, \"compact\": true}}\n</tool_call><|im_end|>\n...\n<|im_start|>assistant\n📅 <b>DAGLIGT OVERBLIK ...</b>\n...<|im_end|>"
}
```

The `text` field is what MLX-LM trains on. Loss is computed over the entire sequence by default; for this task we want loss only on the *assistant* turns (tool calls + final response), not on tool results we feed in. `prepare.py` writes a `prompt`/`completion` variant when `--loss-mask` is set — see below.

## Loss masking

By default MLX-LM trains autoregressively over the whole `text`. For tool-calling fine-tunes this can over-weight the tool *result* tokens (which the model never generates). Two ways to handle it:

- **Quick & dirty (default)** — full-sequence training. Works fine when tool results are short relative to the assistant turns and you have enough data. This is the default for the first training round.
- **Correct (recommended once you have ≥500 examples)** — masked training where loss is only on assistant tokens. Pass `--loss-mask` to `prepare.py` to emit a `{prompt, completion}` schema and switch `lora.yaml` to MLX-LM's `completions` data type.

## Pre-filter rules

`prepare.py` drops pairs that:

1. Have **malformed final HTML** — unbalanced tags, raw `<` not entity-encoded, missing required child sections. Catches Gemini-side mistakes that would teach the model bad output.
2. Have **zero tool calls** — these are conversations that bypassed MCP entirely, useless for tool-calling training.
3. Have **only failing tool calls** (all `ok: false`) — the model would learn that tool calls are pointless.
4. Have **truncated tool results** that suggest the trace was cut off mid-run.
5. Have a final response shorter than ~100 chars — typically a fallback/error message, not a real notification.

Each drop is logged with the conv_id and reason. Inspect with:

```bash
python prepare.py --in pairs.jsonl --out splits/ --report-dropped dropped.jsonl
wc -l dropped.jsonl
```

If more than ~15 % drop, your B1 replay probably produced low-quality data — check whether Aula returned empty results on those dates or Gemini was rate-limited.

## Stratification

Splits preserve the `kind` distribution (weekday / week-end / week-start). Each split contains all three kinds in roughly the same proportion as the full corpus.

## Verification

```bash
wc -l ~/aula-train/splits/*.jsonl
# Expected: train ~270, valid ~15, test ~15 (assuming 300 pairs and 90/5/5 split)

# Spot-check one line parses
head -1 ~/aula-train/splits/train.jsonl | python -c "import json, sys; print(json.loads(sys.stdin.read())['text'][:500])"

# Validate ChatML structure with Hugging Face tokenizer
python -c "
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('Qwen/Qwen2.5-3B-Instruct')
import json
with open('${HOME}/aula-train/splits/train.jsonl') as f:
    line = json.loads(f.readline())
tokens = tok.encode(line['text'])
print('Tokens:', len(tokens))
assert tok.decode(tokens).count('<|im_start|>') >= 4, 'expect at least 4 turns'
"
```

Continue to Phase 4 once `train.jsonl` exists and tokenises cleanly.
