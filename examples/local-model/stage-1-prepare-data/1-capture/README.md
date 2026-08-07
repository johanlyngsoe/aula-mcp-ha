# Phase 1 — Passive capture (B3)

Once Phase 0 is applied, this phase logs every real production daily notification run to JSONL. Zero ops, zero changes to the prompts. Two parallel writers:

- **MCP-side**: `aula-mcp` tracer writes `/config/aula-train/trace-YYYY-MM-DD.jsonl` containing tool calls + args + results (already wired in Phase 0).
- **Conversation-side**: a Node-RED File-out node writes `/config/aula-train/conv-YYYY-MM-DD.jsonl` containing the final prompt + Gemini response.

The two streams are joined in Phase 2 by `sessionId` and timestamp.

## Path A — Node-RED (recommended)

Open Node-RED on HAOS and import [`node-red-flow.json`](./node-red-flow.json). It adds a single File-out node configured to append JSON to `/config/aula-train/conv-{{kind}}-YYYY-MM-DD.jsonl`. Wire it as a fan-out from the same point where your existing flow currently sends to Telegram — the message envelope at that point already has both the prompt (`msg.text` or `msg.payload.prompt`) and the response (`msg.response` or similar, depending on your flow shape).

Adjust the field paths in the File-out node template to match your flow's variable names — the JSON in `node-red-flow.json` uses placeholders.

## Path B — HA YAML automation (no Node-RED)

See [ha-yaml-alternative.md](./ha-yaml-alternative.md).

## Record format

See [schema.md](./schema.md).

## What gets captured

| Source | What | When |
|---|---|---|
| MCP tracer | Every tool call (discover, messages, posts, calendar, ugeplan, …) with args + results | Continuously, any time HA's conversation agent uses MCP |
| Node-RED file node | The final prompt + final response (Danish HTML) + the conversation_id | Once per daily run |

The MCP tracer logs ~6-10 records per daily run. The conversation logger logs 1.

## Verification

After leaving capture running for one full day:

```bash
# On HAOS:
wc -l /config/aula-train/trace-*.jsonl   # expect ~25-30 lines (8-10 per kind × 3 kinds)
wc -l /config/aula-train/conv-*.jsonl    # expect 3 lines (one per kind)

# Sanity check structure:
head -1 /config/aula-train/conv-*.jsonl | jq .
head -1 /config/aula-train/trace-*.jsonl | jq .
```

If `conv-*.jsonl` is empty but `trace-*.jsonl` has data, the conversation logger isn't wired — check Path A or Path B.

If both are empty but the notifications still arrive, your HA conversation pipeline isn't actually going through MCP. Check `AULA_MCP_TRACE_DIR` is set on the `aula-mcp` add-on.

## When to move to Phase 2

You don't have to wait for natural capture to fill your dataset. Phase 2 (historical replay) gives you ~300 examples in an afternoon. Phase 1 keeps running in parallel; its contribution gets folded in on every retrain (Phase 9).
