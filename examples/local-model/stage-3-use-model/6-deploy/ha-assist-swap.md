# Swap HA Assist's conversation agent from Gemini to Ollama

## Add the Ollama integration

HA → Settings → Devices & Services → Add Integration → **Ollama**.

- URL: `http://nuc.local:11434` (or `http://mini.local:11434`).
- Model: `aula:v1` (or whatever tag you used in Phase 6).
- Context window: 16384 (must match `config/Modelfile` `num_ctx`).
- Max history: leave at default unless you see context overflow in HA logs.
- Allow tool use / MCP: **on**. This is what lets Ollama hit `aula-mcp` server entities.
- Prompt template: leave empty — the system prompt baked into the Modelfile + your daily prompts are enough.

## Expose `aula-mcp` to the new agent

HA → Settings → Devices & Services → **MCP Server** integration → confirm `aula-mcp` is listed and "Allowed for Ollama" is checked. (The same toggle you have for Gemini.)

## Create a new Assist pipeline that uses Ollama

HA → Settings → Voice assistants → Add assistant.

- Name: `aula_local`
- Conversation agent: the new Ollama agent
- Speech-to-text / Text-to-speech: not needed (you trigger via service call, not voice)
- LLM use: tools + MCP enabled

Do **not** delete the existing Gemini pipeline yet — you need it for the E3 shadow week and the E4 canary rollback. Keep both pipelines side-by-side.

## Point your daily automation at the new agent

In whatever script / Node-RED flow calls `conversation.process` for the daily notification:

Before:
```yaml
- service: conversation.process
  data:
    agent_id: !secret gemini_agent_id   # the Gemini pipeline
    text: "{{ prompt }}"
```

After:
```yaml
- service: conversation.process
  data:
    agent_id: !secret aula_local_agent_id  # the new Ollama pipeline
    text: "{{ prompt }}"
```

But **don't actually flip** until Phase 7's eval gate passes. The Modelfile / pipeline can sit unused for now.

## Verify the wiring

From HA → Developer Tools → Services:

```yaml
service: conversation.process
data:
  agent_id: aula_local
  text: "Lav et meget kort dansk testopslag — kun for at se at integrationen virker."
```

You should see:
- Ollama logs (NUC/Mac mini): a request arriving.
- `aula-mcp` trace JSONL: zero or one tool call (likely just `aula.discover`).
- HA returns a short Danish response.

If Ollama logs nothing, the agent_id in the call doesn't match the new pipeline's id. Find the right id under Settings → Voice assistants → click the pipeline → look at the URL.

If Ollama receives the request but errors with "model not found", the Ollama integration's model field doesn't match the tag you registered. Update either side.

If Ollama returns text but never calls a tool, check that the MCP integration is enabled in the Ollama integration config (toggled per-MCP-server).

## Rollback (E4 canary)

The E4 automation in Phase 7 watches the structural validator pass-rate sensor. On failure it auto-reverts the daily script's `agent_id` to the Gemini pipeline and notifies you. Until Gemini is fully retired (after several stable weeks), keep that pipeline configured.
