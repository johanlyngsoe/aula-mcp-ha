# Phase 6 — Deploy to inference host

Stand up Ollama on either the Intel NUC or the Mac mini, register the Q4_K_M GGUF as a model, then point HA's Ollama integration at it.

## Decide where to deploy

| Host | Throughput | Power | Notes |
|---|---|---|---|
| Intel NUC i3, 8 GB | ~3-5 tok/s | low, always-on | Fine for once-daily; long tool-call traces take 5-15 min |
| Mac mini (Apple Silicon) | ~30-60 tok/s | low | Almost instant; useful if you also want Assist voice for other domains |

The plan supports both — same GGUF, same Modelfile, same HA integration config. Pick one to start; you can switch by changing one URL in HA's Ollama integration.

## Files

- [ollama-nuc.md](./ollama-nuc.md) — install & tune Ollama on the NUC.
- [ollama-mac-mini.md](./ollama-mac-mini.md) — install & tune Ollama on the Mac mini.
- [ha-assist-swap.md](./ha-assist-swap.md) — swap HA Assist's conversation agent from Gemini to Ollama.
- [healthcheck.sh](./healthcheck.sh) — quick `curl /api/chat` test that validates the deployment end-to-end.

## Run (whichever host)

```bash
# 1. Install Ollama on the host (see ollama-nuc.md or ollama-mac-mini.md).

# 2. Register the model.
scp ~/aula-train/gguf/aula-qwen2.5-3b-lora.Q4_K_M.gguf user@host:/opt/aula/
scp ../config/Modelfile user@host:/opt/aula/
ssh user@host "cd /opt/aula && ollama create aula:v1 -f Modelfile"

# 3. Sanity check.
ssh user@host "ollama run aula:v1 'Sig hej på dansk.'"

# 4. Smoke test the tool-call surface (no MCP wiring yet).
./healthcheck.sh user@host

# 5. Swap HA's conversation agent (ha-assist-swap.md).

# 6. Manually trigger the weekday Assist intent from HA UI and verify
#    Telegram receives a sensible notification.
```

## Sanity checks before cutover

After Ollama is up and HA points at it but **before** you flip your daily automation to use the local agent:

1. `healthcheck.sh` passes with green output.
2. From HA → Settings → Voice assistants, the "aula_local" pipeline (or whatever you named the new Ollama agent) successfully tests with a manual conversation.
3. Confirm `aula-mcp` server entities are exposed to the Ollama agent (HA → Settings → Devices & Services → Ollama integration → Configure → Allow MCP servers).

Continue to Phase 7 for the eval gate.
