# Phase 8 — Deterministic emergency template (D3 fallback)

When Ollama times out, the structural validator rejects the output, or any other failure occurs, a no-LLM script generates a minimal but reliable Telegram message from the raw MCP results. This must exist before cutover — D3 has no Gemini safety net.

## Flow

```
prompt-builder → conversation.process (Ollama)
                      │
                      ├─ ok + validator pass → telegram
                      │
                      └─ fail
                              ↓
                       retry once @ temp=0
                              ↓
                       ├─ ok → telegram
                       │
                       └─ fail
                              ↓
                       8-fallback/emergency-template.ts
                              ↓
                       telegram (degraded format)
```

## Files

- [emergency-template.ts](./emergency-template.ts) — pulls raw data from MCP (the same way Ollama would have), formats a deterministic Telegram-HTML message. No LLM involvement.
- [retry-and-fallback.md](./retry-and-fallback.md) — Node-RED logic with the retry + fallback fan-out.

## What the emergency message looks like

Less polished than Ollama's output. The point is reliability:

```html
🚨 <b>Notifikation kunne ikke genereres normalt</b>
<i>onsdag 17. juni 2026</i>

👤 <b>Anna</b>
📅 <b>I morgen</b>:
- 08:00 Dansk
- 09:00 Matematik
- ...
📢 Nye opslag (2):
- 15:30 — Klassen tager på tur (kræver svar)
- 09:12 — Husk gymnastiktøj
✉️ Beskeder (1):
- Lærer Jensen, 14:22 — "Anna har glemt sin madpakke …"

👤 <b>Lukas</b>
…

<i>Hvis du ser denne besked betyder det at den lokale model fejlede. Tjek logs.</i>
```

No emojis-as-routing-logic, no `kind` filtering. Strip-and-list. The "this is a fallback" footer is intentional — you should notice that you're degraded.

## Cost

Zero. Runs deterministically. Takes a few seconds.

## When to remove

Never. Keep the fallback wired forever. Cheap insurance against:

- Ollama daemon crash
- Mac mini sleeps unexpectedly
- NUC reboots after power blip
- Future Qwen update breaks tool-call grammar
- aula-mcp schema change you forgot to retrain on

## Verification

```bash
# 1. Synthetic failure — kill Ollama mid-day and trigger the flow:
ssh nuc "sudo systemctl stop ollama"
# Trigger Aula weekday flow manually from HA.
# Expect: emergency template message arrives within ~2 minutes.
ssh nuc "sudo systemctl start ollama"

# 2. Synthetic validator failure — force the validator to reject by feeding
# Ollama a prompt that returns garbage (or temporarily make ALLOWED_TOOLS empty):
# Expect: retry triggers, second-retry triggers fallback.

# 3. End-to-end success path:
# Trigger Aula weekday flow normally; expect Ollama success + no fallback.
```
