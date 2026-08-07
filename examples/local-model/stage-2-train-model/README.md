# Section 2 — Train the model

> **Status while you sit here:** Gemini still serves production. All work happens on your Mac. The GGUF artifact stays on your Mac until Section 3 deploys it.

## What you produce

A single quantized model file:

```
~/aula-train/gguf/aula-qwen2.5-3b-lora.Q4_K_M.gguf    ~ 2 GB
```

Ready to be copied to your inference host in Section 3.

## Prerequisites from Section 1

- `~/aula-train/splits/{train,valid,test}.jsonl` populated by Phase 3.
- (recommended) `train.jsonl` ≥ 270 lines.

If you don't have those yet, go back to [Section 1](../stage-1-prepare-data/README.md).

## Tooling you need installed on the Mac

- Python 3.11+, `pip install mlx-lm` (and its dependency chain).
- `git clone https://github.com/ggerganov/llama.cpp ~/src/llama.cpp` + `make -j` in that dir.
- ~20 GB free disk for base-weights cache + checkpoints + GGUF artifacts.

## Phases inside this section

| # | Folder | What | Time on M1 Max |
|---|---|---|---|
| 4 | [4-finetune/](./4-finetune/README.md) | LoRA fine-tune via MLX-LM → fuse → quick structural eval | ~60-120 min training + a few minutes for fuse + eval |
| 5 | [5-convert-gguf/](./5-convert-gguf/README.md) | MLX fused → HuggingFace → GGUF fp16 → Q4_K_M quantize | ~10-20 min |

Both phases are run-and-wait. You can leave them while you do something else.

## Recommended single sitting

```bash
cd examples/local-model/stage-2-train-model/4-finetune
./train.sh                # 1-2 h, watch loss curve
./fuse.sh                 # ~5 min
./eval-e1.sh              # ~5-10 min — gate ≥ 95% grammar + 95% HTML

cd ../5-convert-gguf
./to-hf.sh && ./to-gguf.sh && ./quantize.sh    # ~20 min total
```

If `eval-e1.sh` fails the gate (e.g., 92% grammar), the LoRA didn't train well enough. Two paths:

1. **More data.** Go back to Section 1, run another B1 replay against different past months, regenerate splits, retry.
2. **More training.** Bump rank to 32 in `lora.yaml`, double `iters`, retry. Cheap to try once.

Don't proceed to Section 3 with sub-gate results — you'd just be deploying a broken model.

## "Done" checklist

- [ ] `train.sh` finished without error; validation loss < 1.0.
- [ ] `fuse.sh` produced `~/aula-train/fused-model/` with `weights.safetensors`.
- [ ] `eval-e1.sh` reports grammar ≥ 95% AND HTML ≥ 95% on the fused model.
- [ ] `quantize.sh` produced `~/aula-train/gguf/aula-qwen2.5-3b-lora.Q4_K_M.gguf` (~2 GB).
- [ ] (recommended) Re-run E1 against the Q4 GGUF and confirm pass rates within 2% of the fused result.

Then on to [Section 3](../stage-3-use-model/README.md).

## What to do if you change your mind

Nothing in this section touches production. Delete `~/aula-train/checkpoints/`, `~/aula-train/fused-model/`, `~/aula-train/gguf/` and you're back to where you started. Re-running from Phase 4 is idempotent.
