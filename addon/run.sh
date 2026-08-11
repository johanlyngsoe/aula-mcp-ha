#!/usr/bin/env bash
set -e

OPTS=/data/options.json

export AULA_MCP_DIR="/data"
export AULA_MCP_NO_KEYCHAIN=1
export AULA_MCP_ALLOW_REMOTE=1
export AULA_MCP_HOST="0.0.0.0"
export AULA_MCP_PORT="7878"

AULA_MCP_KEY_VAL=$(jq -r '.aula_mcp_key // empty' "$OPTS" 2>/dev/null || true)
[ -n "$AULA_MCP_KEY_VAL" ] && export AULA_MCP_KEY="$AULA_MCP_KEY_VAL"

MITID_USERNAME=$(jq -r '.mitid_username // empty' "$OPTS" 2>/dev/null || true)
MITID_IDENTITY=$(jq -r '.mitid_identity // 1' "$OPTS" 2>/dev/null || echo "1")

if [ -z "$MITID_USERNAME" ]; then
  echo "--- Aula MCP: 'mitid_username' is not set ---"
  echo "--- Go to Settings → Add-ons → Aula MCP → Configuration, set your MitID username, and restart the addon ---"
  exit 1
fi

echo "--- Aula MCP: startup health check ---"
if bun /app/apps/cli/src/index.ts doctor; then
  echo "--- Health check passed ---"
else
  echo "--- Health check failed ---"
  echo "--- Aula login is required. Run login manually from the add-on container. ---"
  echo "--- Server will start, but Aula tools will not work until login succeeds. ---"
fi

echo "--- Starting MCP server on :$AULA_MCP_PORT ---"
exec bun /app/packages/mcp-server/src/server.ts
