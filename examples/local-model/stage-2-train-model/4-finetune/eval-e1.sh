#!/usr/bin/env bash
# Run E1 (structural) eval on the fused model against the held-out test.jsonl.
# Prints validation loss + tool-call grammar pass + HTML pass.
#
# Doesn't apply quantization — that's Phase 5; here we test what the LoRA
# itself learned, so we can isolate quantization regressions later.

set -euo pipefail

FUSED_DIR="${FUSED_DIR:-${HOME}/aula-train/fused-model}"
TEST_FILE="${TEST_FILE:-${HOME}/aula-train/splits/test.jsonl}"
OUT_DIR="${OUT_DIR:-${HOME}/aula-train/eval}"
# Resolve examples/local-model/ root (two levels up from stage-2-train-model/4-finetune/).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

mkdir -p "${OUT_DIR}"

if [[ ! -d "${FUSED_DIR}" ]]; then
  echo "no fused model at ${FUSED_DIR} — run fuse.sh first" >&2
  exit 1
fi
if [[ ! -f "${TEST_FILE}" ]]; then
  echo "no test set at ${TEST_FILE} — run Phase 3 prepare.py first" >&2
  exit 1
fi

echo "[eval-e1] fused=${FUSED_DIR}"
echo "[eval-e1] test=${TEST_FILE}"

# Delegate to the E1 script in Phase 7 (stage-3-use-model/7-eval) — it owns the structural rules.
python "${ROOT}/stage-3-use-model/7-eval/e1-structural.py" \
  --model "${FUSED_DIR}" \
  --test "${TEST_FILE}" \
  --out "${OUT_DIR}/e1-samples.txt" \
  --report "${OUT_DIR}/e1-report.json"

# Print summary.
python -c "
import json
r = json.load(open('${OUT_DIR}/e1-report.json'))
print(f\"[eval-e1] validation loss: {r['loss']:.3f}\")
print(f\"[eval-e1] grammar pass: {r['grammar_pass']}/{r['n']} ({100*r['grammar_pass']/r['n']:.1f}%)\")
print(f\"[eval-e1] HTML pass:    {r['html_pass']}/{r['n']} ({100*r['html_pass']/r['n']:.1f}%)\")
print(f\"[eval-e1] samples → ${OUT_DIR}/e1-samples.txt\")
"
