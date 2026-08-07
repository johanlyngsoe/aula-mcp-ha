# E3 — Shadow week

For 5-7 consecutive days, the production Telegram message still comes from Gemini. In parallel, the local Ollama agent runs the **same** prompt and posts to a private Telegram channel (or a file). You read both side by side every morning.

Goal: catch things only you notice as the parent. Wrong pronouns, missing kids, tone drift, "i morgen" vs "i overmorgen" confusion, accidentally re-introducing filtered-out posts.

## Wiring (Node-RED — preferred)

In your existing weekday / week-end / week-start flow, immediately after the prompt-builder node, **fan out** to two parallel branches:

```
prompt-builder
   ├── A) conversation.process { agent_id: gemini }  → telegram (public chat)
   └── B) conversation.process { agent_id: aula_local } → telegram (shadow chat)
```

Both branches log their output via the Phase 1 file-out node so you have a paired record.

### Sketch (Node-RED function for branch B)

```js
// Same prompt as branch A, just different agent.
msg.payload = {
  service: 'conversation.process',
  data: {
    agent_id: 'aula_local',     // Phase 6 Ollama pipeline
    text: msg.text,
  },
};
return msg;
```

Then a service-call node, then a telegram-out node pointing at the shadow chat id.

## Daily ritual

Each morning, read both messages. Note any of:

| Class | Examples | Action |
|---|---|---|
| Identical or trivial paraphrase | "📚 Anna har dansk i morgen" vs "📚 Anna: dansk i morgen" | None |
| Stylistic drift acceptable | extra emoji, slightly different ordering of equally-important items | None |
| Factual error | wrong date, wrong child name, missing message-only-info | **Stop**. Add example to the manual fix-up corpus and retrain. |
| Tool-call failure | empty "Beskeder" section when there were 3 unread messages | Check the MCP trace for that conv_id; usually a missing `compact: true` or wrong `pageSize`. |
| Telegram parse error | message arrives mangled or doesn't arrive | Validator must catch this — verify Phase 8 retry-and-fallback is wired. |

Keep a simple text file `~/aula-train/eval/shadow-notes.md` per day. After 5 days, decide:

- **Accept**: cut over (move to Phase 9 cadence).
- **Reject**: collect the failing examples as manual training data, retrain LoRA, run E1 + E2 again, repeat E3.

## What "5 consecutive clean days" really means

- Five days where the local response is at most "trivially different" from Gemini's.
- Three of those days must include at least one actionable message or post (not just empty Aula days), so you actually exercise the model on real signal.
- No factual errors and no Telegram delivery failures.

If you've had a "quiet week" with mostly empty Aula data, extend shadow week another 3-4 days until the model has been tested on real load.

## Cost

Doubles your Gemini-API spend for 5-7 days (one extra call per daily run). Negligible — a few euros at most. Worth it; this is the human gate.
