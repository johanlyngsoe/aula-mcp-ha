#!/usr/bin/env bash
# Quantize the fp16 GGUF down to Q4_K_M (the deployment target) and
# optionally Q5_K_M (a Mac-mini-only fallback if quality regresses).

set -euo pipefail

GGUF_DIR="${GGUF_DIR:-${HOME}/aula-train/gguf}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-${HOME}/src/llama.cpp}"
PRODUCE_Q5="${PRODUCE_Q5:-0}"   # set =1 to also emit a Q5_K_M variant

QUANTIZER="${LLAMA_CPP_DIR}/build/bin/llama-quantize"
if [[ ! -x "${QUANTIZER}" ]]; then
  # legacy build location
  QUANTIZER="${LLAMA_CPP_DIR}/llama-quantize"
fi
test -x "${QUANTIZER}" || { echo "no llama-quantize built in ${LLAMA_CPP_DIR}" >&2; exit 1; }

SRC="${GGUF_DIR}/model-fp16.gguf"
test -f "${SRC}" || { echo "no fp16 source at ${SRC} — run to-gguf.sh first" >&2; exit 1; }

run_quant() {
  local kind="$1"
  local out="${GGUF_DIR}/model-${kind,,}.gguf"
  echo "[quantize] ${kind}"
  "${QUANTIZER}" "${SRC}" "${out}" "${kind}"
  echo "[quantize] ${out} → $(du -h "${out}" | cut -f1)"
}

run_quant Q4_K_M

if [[ "${PRODUCE_Q5}" = "1" ]]; then
  run_quant Q5_K_M
fi

# Convenient symlink for Phase 6's Modelfile expectation.
ln -sf "${GGUF_DIR}/model-q4_k_m.gguf" \
  "${GGUF_DIR}/aula-qwen2.5-3b-lora.Q4_K_M.gguf"

echo "[quantize] done."
echo "[quantize] Next: copy aula-qwen2.5-3b-lora.Q4_K_M.gguf to your inference host"
echo "          (NUC or Mac mini) and follow 6-deploy/."
