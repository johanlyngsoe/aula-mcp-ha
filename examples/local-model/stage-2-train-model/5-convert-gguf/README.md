# Phase 5 — MLX → GGUF + quantize

Take the fused MLX model from Phase 4 and turn it into a Q4_K_M GGUF that Ollama can serve on the NUC or Mac mini.

## Prerequisites

- Phase 4 produced `~/aula-train/fused-model/` (an MLX model dir).
- `llama.cpp` cloned + built on the Mac (for the converter and quantizer):
  ```bash
  cd ~/src
  git clone https://github.com/ggerganov/llama.cpp
  cd llama.cpp
  make -j   # llama-quantize is the binary we need; the converter is Python
  pip install -r requirements.txt
  ```
- `LLAMA_CPP_DIR` env var pointing at the clone (default: `~/src/llama.cpp`).
- Free disk ≥ 20 GB (fp16 GGUF is ~6 GB, Q4 + Q5 outputs add ~5 GB).

## Files

- [to-hf.sh](./to-hf.sh) — convert MLX fused → HuggingFace format (which the llama.cpp converter understands).
- [to-gguf.sh](./to-gguf.sh) — HuggingFace dir → `model-fp16.gguf`.
- [quantize.sh](./quantize.sh) — produces `model-q4_k_m.gguf` (target, ~2 GB) + optionally `model-q5_k_m.gguf` (~2.5 GB, higher quality fallback for Mac mini).

## Run

```bash
cd examples/local-model/5-convert-gguf

./to-hf.sh        # ~/aula-train/fused-model/ → ~/aula-train/hf-model/
./to-gguf.sh      # ~/aula-train/hf-model/ → ~/aula-train/gguf/model-fp16.gguf
./quantize.sh     # → model-q4_k_m.gguf (+ optionally model-q5_k_m.gguf)
```

## Validation (GGUF round-trip)

Before shipping to Ollama, confirm Q4 didn't break the model:

```bash
# Smoke test the GGUF directly with llama.cpp:
"${LLAMA_CPP_DIR}/build/bin/llama-cli" \
  -m ~/aula-train/gguf/model-q4_k_m.gguf \
  -p "<|im_start|>system\nDu er en assistent...<|im_end|>\n<|im_start|>user\nSig hej.<|im_end|>\n<|im_start|>assistant\n" \
  -n 32 -t 8

# Should produce a short Danish greeting.
```

For a structural round-trip vs the MLX fused model, run Phase 7's `e1-structural.py` against the GGUF (`--model ~/aula-train/gguf/model-q4_k_m.gguf --backend llama-cpp`). Pass rates should match MLX within 1-2 %.

## Quantization comparison

| Format | Size | Quality vs fp16 | NUC tok/s | Mac mini tok/s |
|---|---|---|---|---|
| fp16 | ~6 GB | reference | ~1 (rarely usable) | ~25 |
| Q5_K_M | ~2.5 GB | ~99 % | ~3 | ~40 |
| Q4_K_M (default) | ~2 GB | ~98 % | ~5 | ~50 |
| Q4_0 (legacy) | ~1.9 GB | ~96 % | ~6 | ~55 |

Q4_K_M is the sweet spot for this task. Go to Q5_K_M only if E1/E2 regress noticeably; don't drop below Q4_K_M.

## Next

`quantize.sh` outputs end up in `${GGUF_DIR:-~/aula-train/gguf/}`. Copy or symlink the Q4_K_M file into `6-deploy/` (or scp to the NUC) for Ollama registration.
