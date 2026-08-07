#!/usr/bin/env bash
# Convert HuggingFace safetensors → GGUF fp16 using llama.cpp's converter.

set -euo pipefail

HF_DIR="${HF_DIR:-${HOME}/aula-train/hf-model}"
GGUF_DIR="${GGUF_DIR:-${HOME}/aula-train/gguf}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-${HOME}/src/llama.cpp}"

if [[ ! -d "${HF_DIR}" ]]; then
  echo "no HF model at ${HF_DIR} — run to-hf.sh first" >&2
  exit 1
fi

if [[ ! -d "${LLAMA_CPP_DIR}" ]]; then
  cat >&2 <<EOF
llama.cpp not found at ${LLAMA_CPP_DIR}.
  git clone https://github.com/ggerganov/llama.cpp ~/src/llama.cpp
  cd ~/src/llama.cpp && make -j
  pip install -r requirements.txt
Or set LLAMA_CPP_DIR.
EOF
  exit 1
fi

CONVERTER="${LLAMA_CPP_DIR}/convert_hf_to_gguf.py"
if [[ ! -f "${CONVERTER}" ]]; then
  # older filename (pre-2024-Q3)
  CONVERTER="${LLAMA_CPP_DIR}/convert-hf-to-gguf.py"
fi
test -f "${CONVERTER}" || { echo "no converter found in ${LLAMA_CPP_DIR}" >&2; exit 1; }

mkdir -p "${GGUF_DIR}"
OUT="${GGUF_DIR}/model-fp16.gguf"

echo "[to-gguf] ${HF_DIR} → ${OUT}"

python "${CONVERTER}" \
  "${HF_DIR}" \
  --outtype f16 \
  --outfile "${OUT}"

test -s "${OUT}" || { echo "[to-gguf] empty output" >&2; exit 1; }
echo "[to-gguf] done ($(du -h "${OUT}" | cut -f1))"
