# Phase 0 — Bootstrap

One-time additive patches to the existing codebase. **Production behaviour is unchanged** until you opt in:

- `getNow()` shim uses `new Date()` by default; only diverges when `AULA_REPLAY_DATE` is set.
- MCP tracer is silent unless `AULA_MCP_TRACE_DIR` is set.
- `compact=true` flag on verbose tools is opt-in; absent / false → original verbose output.

Apply these in any order. Each is independent.

## Files

| File | Where | What |
|---|---|---|
| **[apply-as-haos-addon.md](./apply-as-haos-addon.md)** — start here if you run aula-mcp as a HAOS add-on | HAOS | End-to-end walkthrough mapping the three patches onto your add-on workflow (Node-RED edit + `aula-mcp-ha` source push + add-on rebuild) |
| [apply-now-shim.md](./apply-now-shim.md) | `examples/daily-overview-prompts/*.js` (or the matching Node-RED function nodes) | Replace direct `new Date()` with `getNow()` for date-controllable replay |
| [apply-mcp-tracer.md](./apply-mcp-tracer.md) | `packages/mcp-server/src/setup.ts` (+ small helper) | Log every tool call to JSONL when `AULA_MCP_TRACE_DIR` is set |
| [apply-compact-flag.md](./apply-compact-flag.md) | `packages/mcp-server/src/tools.ts` | Add `compact: z.boolean().optional()` arg on `aula.posts.list`, `aula.messages.list_threads`, `aula.messages.get_thread`, and the seven `aula.ugeplan.*` tools |
| [verify-haos-paths.md](./verify-haos-paths.md) | HAOS | Create `/config/aula-train/` with the right perms; verify rotation works |

## Verification after applying all four

```bash
# 1. Existing tests still pass (compact + tracer should not change current behaviour)
cd /Users/madslundt/Documents/aula-mcp
bun test

# 2. Tracer is silent without env var
AULA_MCP_LOG=1 bun packages/mcp-server/src/server-stdio.ts   # should not create any trace file

# 3. Tracer fires when env var set
mkdir -p /tmp/aula-trace
AULA_MCP_TRACE_DIR=/tmp/aula-trace AULA_MCP_LOG=1 \
  bun packages/mcp-server/src/server-stdio.ts &
# Drive a single tool call from any MCP client, then:
cat /tmp/aula-trace/*.jsonl | head -1   # expect {ts, sessionId, tool, args, result, duration_ms}

# 4. Compact flag short-circuits the verbose branch on posts.list
# (Manual: call aula.posts.list with compact: true from your normal MCP client and
# confirm response is materially smaller than without it.)

# 5. now() shim respects override
AULA_REPLAY_DATE=2026-04-15T08:00:00 \
  node -e "$(cat examples/daily-overview-prompts/prompt-weekday.js)" 
# The emitted text should mention 'I DAG er onsdag 15. april 2026'
```

If any step fails, see the corresponding patch doc for troubleshooting.

## Risk assessment

| Patch | Risk | Mitigation |
|---|---|---|
| now-shim | None — additive, env-var-gated | Default behaviour identical |
| MCP tracer | Disk I/O on every tool call when enabled | Async fire-and-forget write; bounded file size + daily rotation |
| Compact flag | New code path in three+ tools | Conditional on arg; covered by added unit tests in the patch doc |
| HAOS paths | Wrong owner/perms blocks writes | `verify-haos-paths.md` script catches it |
