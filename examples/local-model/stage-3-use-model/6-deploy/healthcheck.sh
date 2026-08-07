#!/usr/bin/env bash
# Quick end-to-end sanity check of an Ollama deployment.
#
# Usage: ./healthcheck.sh [host[:port]]
#   default: localhost:11434

set -euo pipefail

HOST="${1:-localhost:11434}"
URL="http://${HOST}"
MODEL="${OLLAMA_MODEL:-aula}:${OLLAMA_TAG:-v1}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yel()   { printf '\033[33m%s\033[0m\n' "$*"; }

echo "host=${URL}  model=${MODEL}"
echo

# 1. Server reachable.
if ! curl -fsS "${URL}/api/tags" -o /tmp/healthcheck-tags.json; then
  red "FAIL: ${URL}/api/tags unreachable"
  exit 1
fi
green "OK: server responds"

# 2. Model registered.
if ! jq -e --arg m "${MODEL}" '.models[] | select(.name == $m)' /tmp/healthcheck-tags.json > /dev/null; then
  red "FAIL: model ${MODEL} not registered"
  echo "Available:"
  jq -r '.models[].name' /tmp/healthcheck-tags.json | sed 's/^/  /'
  exit 1
fi
green "OK: model ${MODEL} present"

# 3. Generation works.
echo
echo "Generating a 1-shot response (no tool calls)..."
RESP=$(curl -fsS "${URL}/api/generate" -d "$(jq -nc --arg m "${MODEL}" '{model: $m, prompt: "Sig hej på dansk i 5 ord.", stream: false}')")
TEXT=$(echo "${RESP}" | jq -r '.response')
DURATION=$(echo "${RESP}" | jq -r '.total_duration / 1e9 | floor')

if [[ -z "${TEXT}" ]]; then
  red "FAIL: empty response"
  echo "${RESP}" | jq .
  exit 1
fi

green "OK: response in ${DURATION}s:"
echo "  ${TEXT}"

# 4. Tool-call surface (chat API with empty tools array).
echo
echo "Verifying chat/tools API path..."
TOOLS_RESP=$(curl -fsS "${URL}/api/chat" -d "$(jq -nc --arg m "${MODEL}" '
  {
    model: $m,
    messages: [{role: "user", content: "Sig hej."}],
    tools: [],
    stream: false
  }')")
if echo "${TOOLS_RESP}" | jq -e '.message.content' > /dev/null; then
  green "OK: chat API responds"
else
  yel  "WARN: chat API call did not produce .message.content — inspect manually"
  echo "${TOOLS_RESP}" | jq .
fi

echo
green "All checks passed. Next: ha-assist-swap.md"
