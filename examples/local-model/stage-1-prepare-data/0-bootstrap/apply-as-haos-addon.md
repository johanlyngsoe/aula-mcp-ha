# Applying Phase 0 when aula-mcp runs as a HAOS add-on

You're running aula-mcp as a HAOS add-on. The `addon/Dockerfile` clones source from `github.com/madslundt/aula-mcp-ha` at build time, so source changes need to land in that repo and the add-on needs to be rebuilt.

## What goes where

| Phase 0 patch | Lives in | How you apply |
|---|---|---|
| `getNow()` shim (`apply-now-shim.md`) | Node-RED function nodes in HA | Edit in Node-RED UI. **No add-on rebuild.** |
| MCP tracer (`apply-mcp-tracer.md`) | aula-mcp source code | Patch source → push to `aula-mcp-ha` → Rebuild add-on. |
| `compact=true` flag (`apply-compact-flag.md`) | aula-mcp source code | Bundled with tracer in the same rebuild. |
| HAOS path setup (`verify-haos-paths.md`) | HAOS host config | Done from HAOS shell; uses `/config/aula-train/`. |

## End-to-end sequence

### 1. Node-RED (`now()` shim)

- Open Node-RED on HAOS (default: `https://homeassistant.local:1880/`).
- For each of your three daily-prompt flows (weekday, week-end, week-start):
  - Open the function node containing the prompt body.
  - Replace the `const today = new Date();` block with the shim from [`apply-now-shim.md`](./apply-now-shim.md).
  - Add the "Send ALTID compact: true …" line to the DATA section.
- Click **Deploy**.

Production behaviour is identical until you set `AULA_REPLAY_DATE` (which only happens during Stage 1 Phase 2 replay).

### 2. aula-mcp source (tracer + compact flag)

In your local clone:

```bash
cd /Users/madslundt/Documents/aula-mcp
git checkout -b add-tracer-and-compact

# Follow the patch instructions in:
#   ./examples/local-model/stage-1-prepare-data/0-bootstrap/apply-mcp-tracer.md
#   ./examples/local-model/stage-1-prepare-data/0-bootstrap/apply-compact-flag.md

# Verify nothing regresses
bun test

git commit -am "feat(mcp): tool-call tracer + compact flag on verbose tools"
```

Push to whichever GitHub remote your add-on's Dockerfile clones from. By default that's `https://github.com/madslundt/aula-mcp-ha`. If your local repo is a different remote, set up a second remote and push there too:

```bash
git remote add ha-fork https://github.com/madslundt/aula-mcp-ha.git
git push ha-fork add-tracer-and-compact
# then merge to main on the ha-fork side
```

### 3. Add-on packaging (`addon/config.yaml` + `addon/run.sh`)

Two small edits in the add-on packaging:

**`addon/config.yaml`** — expose `/config` so the tracer can write where Node-RED also writes:

```diff
 map:
   - data:rw
+  - config:rw
```

**`addon/run.sh`** — point the tracer at the shared location:

```diff
 export AULA_MCP_DIR="/data"
 export AULA_MCP_NO_KEYCHAIN=1
 export AULA_MCP_ALLOW_REMOTE=1
 export AULA_MCP_HOST="0.0.0.0"
 export AULA_MCP_PORT="7878"
+export AULA_MCP_TRACE_DIR="/config/aula-train"
```

Bump `addon/config.yaml`'s `version` field so HA knows to rebuild (and so the Docker layer cache is busted as documented in the Dockerfile comment).

Commit + push the same way.

### 4. Rebuild the add-on

In HA UI:
1. Settings → Add-ons → **Aula MCP** → ⋮ → **Rebuild**.
2. Wait for the build log to finish ("Add-on Aula MCP has been started").
3. Open the Log tab; you should see your usual startup messages.

If you have `AULA_MCP_LOG=1` enabled, you'll also see `aula-mcp.listening` and per-request log lines.

### 5. Verify the tracer is writing

SSH into HAOS (Settings → Add-ons → **SSH & Web Terminal**):

```bash
# Directory exists (created on first write, but verify_haos_paths.md may pre-create it)
ls -la /config/aula-train/

# Trigger one of your three daily flows manually from HA → Developer Tools → Services
# → conversation.process with your usual prompt input.

# Watch trace file fill up:
tail -f /config/aula-train/trace-$(date +%F).jsonl
```

Expect ~6-10 JSONL lines per daily run (one per MCP tool call).

### 6. Wire Node-RED capture (Phase 1)

Now both writers (MCP tracer + Node-RED file node) land in the same `/config/aula-train/` directory. Move on to [Phase 1 capture](../1-capture/README.md) to add the conversation log.

## Iteration tip — local-source builds

The "push to GitHub → rebuild" loop is slow if you're iterating on the tracer. For development you can convert the add-on to a local-source build:

1. Copy `addon/` to `/addons/local/aula_mcp/` on HAOS (via SSH or the Samba add-on).
2. Replace the `RUN git clone …` step in the Dockerfile with `COPY . /app`.
3. Sync your local source tree to `/addons/local/aula_mcp/source/` on each iteration.
4. HA → Settings → Add-ons → **Local Add-ons → Aula MCP** → Install/Rebuild.

This skips the GitHub round-trip and rebuilds purely from the rsynced source. Once tracer + compact flag are stable, switch back to the published add-on.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `trace-*.jsonl` after manual tool call | `AULA_MCP_TRACE_DIR` not exported, or container can't write to `/config` | Re-check `addon/run.sh` and `addon/config.yaml` map directive; verify with `docker exec addon_aula_mcp env \| grep AULA_MCP_TRACE_DIR` from HAOS shell |
| Tracer writes but `sessionId` is `unknown` | `createMcpApp` wasn't given the sessionId; you applied the tracer patch but missed the matching change in `server.ts` lines around 104 | Reapply patch 2 — both edits are required |
| Add-on rebuilds successfully but the tracer code isn't included | Dockerfile cloned from `aula-mcp-ha` repo but you only pushed to your local repo | `git push ha-fork main` (or whichever remote `aula-mcp-ha` is) |
| `compact: true` arg is rejected by HA's conversation agent as unknown | Either the patch wasn't included in the rebuild, or Ollama's Modelfile system prompt is missing the "always pass compact=true" instruction (Section 3 concern, not Section 1) | Verify rebuild; for Section 1 / Gemini just confirm the schema accepts the arg |
