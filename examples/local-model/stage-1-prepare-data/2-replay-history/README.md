# Phase 2 — Historical replay (B1)

Backfill ~300 training examples in an afternoon by replaying past dates through your existing Gemini conversation path. Uses the `AULA_REPLAY_DATE` shim from Phase 0 and the same `aula-mcp` tracer + Node-RED capture from Phase 1.

## Prerequisites

- Phase 0 patches applied (especially the `getNow()` shim).
- Phase 1 capture is wired and verified.
- Paid Gemini API tier (free tier retains data for training).
- `.env` set with `GEMINI_API_KEY` and `HAOS_CAPTURE_DIR`.

## How it works

For each chosen past date D:

1. Set `AULA_REPLAY_DATE=D` (ISO 8601) in the environment of the prompt-builder.
2. Trigger your existing daily-notification flow on HA. The shim makes the prompt think "today is D".
3. HA's conversation agent runs the full pipeline: it calls MCP tools (which fetch real Aula data for that historical window), Gemini formats the response.
4. MCP tracer logs `trace-D.jsonl`; Node-RED logs `conv-D.jsonl`. Both back-dated to D via the same shim.
5. After all dates run, `join-with-trace.ts` merges the two streams into training-ready `pairs.jsonl`.

Total cost: ~300 Gemini API calls × ~30K tokens each. Roughly €3-5 on Gemini paid tier.

## Files

- [replay.ts](./replay.ts) — orchestrates the replay loop. Bun script. Triggers HA via WebSocket, sets `AULA_REPLAY_DATE` either by env var (if your flow reads it server-side) or by passing it as a conversation arg.
- [date-picker.ts](./date-picker.ts) — picks which past dates to replay. Stratifies by weekday/Friday/Sunday and across calendar weeks for diversity.
- [join-with-trace.ts](./join-with-trace.ts) — joins the two JSONL streams into `pairs.jsonl`.

## Run

```bash
cd examples/local-model/2-replay-history
cp ../config/.env.example .env  # edit HAOS_HOST, HA_TOKEN, GEMINI_API_KEY, etc.

# Pick dates and dry-run print them
bun run date-picker.ts --months 6 --dry-run

# Execute the replay (writes to HAOS /config/aula-train/)
bun run replay.ts --months 6

# Pull the JSONLs back to the Mac
rsync -av "${HAOS_HOST}:${HAOS_CAPTURE_DIR}/" "${RAW_DIR}/"

# Join into training-ready pairs
bun run join-with-trace.ts --in "${RAW_DIR}" --out "${RAW_DIR}/pairs.jsonl"
```

## What "stratified" means

- 70 % weekdays (Mon–Thu) → `prompt-weekday`
- 15 % Fridays → `prompt-week-end`
- 15 % Sundays → `prompt-week-start`
- Spread evenly across the last N months.
- Plus 5–10 "busy" dates picked from days where Aula has high post or message counts (poor man's diversity sampler — see `date-picker.ts`).

If your school year has Aula activity gaps (summer / Christmas), the picker skips them automatically (no MCP results → not worth a training example).

## Safety

- The replay only **reads** Aula data — no posts, messages, or RSVPs are sent.
- Telegram notification suppression: the replay harness sets `msg.suppress_telegram = true` in the Node-RED flow header; your Telegram-out node should skip when set. (See `replay.ts` for the exact mechanism.)
- If Aula rate-limits, the script backs off exponentially up to 60 s, then resumes.

## Resume

`replay.ts` writes a `replay-progress.jsonl` checkpoint per completed date. Re-running picks up where it left off. Safe to Ctrl-C.

## Verification

After completion:

```bash
wc -l "${RAW_DIR}/pairs.jsonl"   # expect ~300 (or whatever you picked)
head -1 "${RAW_DIR}/pairs.jsonl" | jq 'keys'
# Expect: [ "conv_id", "kind", "prompt", "response", "ts", "tool_calls" ]
# where tool_calls is an array of {tool, args, result, duration_ms, ok}
```

## Things that go wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| 300 trace files but 0 conv files | Node-RED flow didn't see `AULA_REPLAY_DATE` because the env var is on the wrong process | Pass the date via `msg.replay_date` and have the prompt-builder read both env and msg |
| Empty tool results | Aula history doesn't go back that far for some widgets | Reduce `--months`; ugeplan widgets often only cache 6-8 weeks |
| Gemini throttling | Free tier or 60 RPM limit | Add `--delay 1500` to `replay.ts` |
| Duplicate dates in pairs.jsonl | Replay was Ctrl-C'd and rerun without checkpoint cleanup | `rm replay-progress.jsonl` and start over — idempotent on the HAOS side |

## When you have enough

Continue to Phase 3 once `pairs.jsonl` has at least ~300 records. Fewer is fine for a first attempt — just expect more tuning later.
