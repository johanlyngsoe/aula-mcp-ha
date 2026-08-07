# Phase 4 — LoRA fine-tune on M1 Max

Train a LoRA adapter for Qwen2.5-3B-Instruct using MLX-LM. Targets a templated tool-calling task; rank=16 is a strong starting point.

## Prerequisites

- MLX-LM installed: `pip install mlx-lm` (requires Python 3.11+).
- `~/aula-train/splits/` populated by Phase 3.
- Free disk ≥ 20 GB on the Mac (base weights cache + checkpoints).
- M1 Max with 64 GB RAM — this is plenty headroom; you can train comfortably with `batch_size: 2` at `seq_length: 8192`.

## Files

- [train.sh](./train.sh) — wrapper around `python -m mlx_lm.lora --train`. Reads `../config/lora.yaml`.
- [fuse.sh](./fuse.sh) — merges the LoRA adapter into the base weights → `~/aula-train/fused-model/`.
- [eval-e1.sh](./eval-e1.sh) — runs the held-out `test.jsonl` and reports validation loss + E1 (structural) pass rate.

## Run

```bash
cd examples/local-model/4-finetune

./train.sh             # ~60-120 min on M1 Max for 600 iters
# Watches loss every 10 steps, evaluates every 50 steps, checkpoints every 100.
# When loss curve flattens (or before iters runs out), Ctrl-C is safe — the
# last checkpoint is the adapter you fuse.

./fuse.sh              # fuses ~/aula-train/checkpoints/lora-adapter into the base
# Produces ~/aula-train/fused-model/  (full MLX weights, ready for Phase 5)

./eval-e1.sh           # runs test.jsonl through the fused model + structural checks
# Aim for: validation_loss < 1.0, tool-call grammar ≥ 95%, HTML pass ≥ 95%.
```

## What good training looks like

For Qwen2.5-3B + rank 16 + lr 1e-4 + ~270 training examples:

| Step | Train loss | Valid loss | Notes |
|---|---|---|---|
| 50 | ~1.8 | ~1.7 | Warm-up |
| 200 | ~0.9 | ~0.95 | Picking up format |
| 400 | ~0.6 | ~0.75 | Tool-call grammar locked in |
| 600 | ~0.45 | ~0.7 | Plateau; stop here |

If valid loss climbs while train drops → overfit. Reduce iters, drop rank to 8, or add data.

If both losses plateau high (>1.0) → undertrained. Bump rank to 32, double iters, or add data.

## When to retrain from scratch vs continue

- **Continue** (load existing adapter + more iters) when you've added 10-30 new examples from B3 capture and want to refresh.
- **Retrain from scratch** when the dataset has grown by ≥ 50 % or the base model has changed (e.g., new Qwen release).

`fuse.sh` supports `--from-checkpoint` for continuation; defaults to fresh fuse.

## Memory tuning

| Symptom | Try |
|---|---|
| Out of memory on Mac (rare on 64 GB) | drop `batch_size` to 1 in `lora.yaml` |
| Out of memory on Mac (definitely on 32 GB) | drop `max_seq_length` to 6144 |
| Iterations are slow (<5 it/s) | `grad_checkpoint: true` already set; try smaller `max_seq_length` |

## Reproducibility

`lora.yaml`'s `seed: 42` makes training deterministic given the same data. Bump per retrain so checkpoint files don't collide.

## Verification

After `eval-e1.sh`:

```
[eval-e1] validation loss: 0.71
[eval-e1] grammar pass: 14/15 (93.3%)         ← bump to ≥95% before continuing
[eval-e1] HTML pass:    15/15 (100%)
[eval-e1] sample outputs written to ~/aula-train/eval/e1-samples.txt
```

Open `e1-samples.txt` and skim 3-5 outputs by eye. Catch any obvious nonsense before moving to Phase 5.
