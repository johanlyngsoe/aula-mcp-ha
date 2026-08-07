#!/usr/bin/env bash
# Run MLX-LM LoRA training using config/lora.yaml.
#
# Resumes from the latest checkpoint if one exists in adapter_path.
# Ctrl-C is safe — the last save_every checkpoint is the adapter you keep.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${ROOT}/config/lora.yaml"

if [[ ! -f "${CONFIG}" ]]; then
  echo "missing ${CONFIG} — copy config/lora.yaml.example or run from a clean checkout" >&2
  exit 1
fi

# Expand ~ in data + adapter paths.
DATA_DIR="${DATA_DIR:-${HOME}/aula-train/splits}"
ADAPTER_DIR="${ADAPTER_DIR:-${HOME}/aula-train/checkpoints/lora-adapter}"

mkdir -p "${ADAPTER_DIR}"

echo "[train] config=${CONFIG}"
echo "[train] data=${DATA_DIR}"
echo "[train] adapter=${ADAPTER_DIR}"

# `python -m mlx_lm.lora` is the canonical entrypoint for MLX-LM ≥ 0.21.
# Older mlx-lm packaged it as `mlx_lm.lora` (no `-m`); fall back gracefully.
if python -c "import mlx_lm.lora" 2>/dev/null; then
  python -m mlx_lm.lora \
    --config "${CONFIG}" \
    --data "${DATA_DIR}" \
    --adapter-path "${ADAPTER_DIR}" \
    "$@"
else
  echo "MLX-LM not installed: pip install -U mlx-lm" >&2
  exit 1
fi
