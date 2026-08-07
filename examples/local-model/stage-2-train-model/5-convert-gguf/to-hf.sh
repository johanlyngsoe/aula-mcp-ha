#!/usr/bin/env bash
# Convert the fused MLX model into HuggingFace format so that llama.cpp's
# converter can read it.
#
# MLX-LM ships an `mlx_lm.convert` that goes BOTH ways. Here we use it in
# reverse — turn an MLX dir back into HF-format safetensors + config.json.

set -euo pipefail

FUSED_DIR="${FUSED_DIR:-${HOME}/aula-train/fused-model}"
HF_DIR="${HF_DIR:-${HOME}/aula-train/hf-model}"

if [[ ! -d "${FUSED_DIR}" ]]; then
  echo "no fused model at ${FUSED_DIR} — run 4-finetune/fuse.sh first" >&2
  exit 1
fi

# Ensure we don't double-convert.
if [[ -d "${HF_DIR}" && -f "${HF_DIR}/config.json" ]]; then
  echo "[to-hf] HF model already exists at ${HF_DIR}; skipping. Remove it to re-convert."
  exit 0
fi

mkdir -p "${HF_DIR}"

echo "[to-hf] ${FUSED_DIR} → ${HF_DIR}"

# `mlx_lm.convert` with --quantize false reverts MLX → HF safetensors.
python -m mlx_lm.convert \
  --hf-path "${FUSED_DIR}" \
  --mlx-path "${HF_DIR}" \
  --quantize false \
  --dtype float16 \
  --upload-repo "" 2>/dev/null \
  || python -m mlx_lm.convert --hf-path "${FUSED_DIR}" --mlx-path "${HF_DIR}" --dtype float16

# Sanity check.
test -f "${HF_DIR}/config.json" || { echo "[to-hf] missing config.json in output" >&2; exit 1; }
echo "[to-hf] done"
