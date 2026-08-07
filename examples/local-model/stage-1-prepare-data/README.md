# Section 1 — Prepare training data

> **Status while you sit here:** Gemini stays as your production conversation agent. Nothing about the daily Telegram notifications changes. This section only *adds* silent logging and runs a one-off historical replay.

## What you produce

A populated training dataset on your Mac:

```
~/aula-train/raw/pairs.jsonl    ~ 300+ (input, tool_calls[], response) examples
```

Once that file has ≥ ~300 lines, you can move to [Section 2 — Train](../stage-2-train-model/README.md). Or you can sit here longer and let passive capture keep growing it. There's no expiry on this state.

## What you change in production

| Change | Where | Why it's safe |
|---|---|---|
| `getNow()` shim | `examples/daily-overview-prompts/*.js` | Defaults to wall clock when `AULA_REPLAY_DATE` is unset. Production behaviour identical. |
| MCP tracer | `packages/mcp-server/src/setup.ts` (+ new file) | Silent unless `AULA_MCP_TRACE_DIR` is set. Production behaviour identical. |
| `compact=true` flag on verbose tools | `packages/mcp-server/src/tools.ts` | Opt-in arg. When unset/false, original verbose output preserved. |
| Node-RED File-out node | Your existing daily flows | Tee writes a JSONL line per run to `/config/aula-train/`. No impact on the Telegram-out branch. |

All four are **additive**. Gemini doesn't know any of this is happening.

## Phases inside this section (in order)

| # | Folder | What | Time |
|---|---|---|---|
| 0 | [0-bootstrap/](./0-bootstrap/README.md) | Apply the four additive patches above | ~30 min one-off |
| 1 | [1-capture/](./1-capture/README.md) | Wire Node-RED File-out (or HA YAML alternative). Runs forever after. | ~10 min one-off |
| 2 | [2-replay-history/](./2-replay-history/README.md) | One-off historical replay against the last ~6 months of Aula data | ~1 afternoon, ~€3-5 Gemini |
| 3 | [3-prepare-dataset/](./3-prepare-dataset/README.md) | Join capture + trace JSONLs → MLX-LM training format → train/valid/test splits | ~5 min |

## Suggested order if you only want to leave it running for now

1. Do **Phase 0** (apply the patches). All back-compatible.
2. Do **Phase 1** (Node-RED capture). Now your daily runs are silently building a dataset.
3. **Stop here** and walk away. Come back in 1-3 months and look at `wc -l /config/aula-train/conv-*.jsonl`.
4. When you have time for an afternoon, do **Phase 2** (historical replay) to backfill the rest.
5. Do **Phase 3** (prepare dataset) immediately before Section 2.

Or if you want to move faster:

1. Phases 0 + 1 + 2 in one sitting (~half a day).
2. Phase 3 immediately after.
3. On to Section 2.

## "Done" checklist

- [ ] All four patches in Phase 0 applied; existing tests pass.
- [ ] `/config/aula-train/conv-*.jsonl` has at least one line per kind from a real daily run.
- [ ] `/config/aula-train/trace-*.jsonl` has at least 6 tool-call records from the same run.
- [ ] (optional but recommended) `~/aula-train/raw/pairs.jsonl` has ≥ 300 lines.
- [ ] `python prepare.py` produced `splits/{train,valid,test}.jsonl` with no error.

Once those check, you're ready for Section 2 whenever you decide to start it.

## What to do if you change your mind

Every change in this section is reverted by one `git revert` (the patches) + removing the Node-RED capture node. The captured JSONL data on HAOS can be deleted at any time without affecting production.
