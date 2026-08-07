#!/usr/bin/env bash
# Fuse the trained LoRA adapter into the base weights.
# Output is a full MLX model dir ready for Phase 5 (GGUF conversion).

set -euo pipefail

MODEL="${MODEL_ID:-Qwen/Qwen2.5-3B-Instruct}"
ADAPTER_DIR="${ADAPTER_DIR:-${HOME}/aula-train/checkpoints/lora-adapter}"
FUSED_DIR="${FUSED_DIR:-${HOME}/aula-train/fused-model}"

if [[ ! -d "${ADAPTER_DIR}" ]]; then
  echo "missing adapter at ${ADAPTER_DIR} — run train.sh first" >&2
  exit 1
fi

mkdir -p "${FUSED_DIR}"

echo "[fuse] base model    = ${MODEL}"
echo "[fuse] adapter       = ${ADAPTER_DIR}"
echo "[fuse] fused output  = ${FUSED_DIR}"

python -m mlx_lm.fuse \
  --model "${MODEL}" \
  --adapter-path "${ADAPTER_DIR}" \
  --save-path "${FUSED_DIR}"

echo "[fuse] done. Next: 5-convert-gguf/to-hf.sh"
