# Section 3 — Use the model

> **Status during this section:** the model runs alongside Gemini before cutover. After the strict eval gate passes and you cut over, Ollama becomes the active conversation agent and Gemini is retired. There is no Gemini safety net after cutover (D3 design) — the deterministic emergency template in Phase 8 is the only fallback.

## What you produce

- A running Ollama instance on the NUC or Mac mini.
- HA's Assist pipeline switched from Gemini to Ollama.
- Three monitoring + safety nets in place (validator pass-rate sensor, canary auto-rollback, deterministic emergency template).
- A monthly retrain loop you can sustain forever.

## Prerequisites from Section 2

- `~/aula-train/gguf/aula-qwen2.5-3b-lora.Q4_K_M.gguf` ready to ship.
- Phase 5 round-trip check passed (Q4 GGUF E1 within 2% of fused model).

## Phases inside this section

| # | Folder | What | Effort |
|---|---|---|---|
| 6 | [6-deploy/](./6-deploy/README.md) | Install Ollama on inference host, register model, swap HA Assist's conversation agent | ~30 min |
| 7 | [7-eval/](./7-eval/README.md) | Strict eval gate: E1 structural + E2 LLM-as-judge + E3 shadow week + E4 production canary | ~5-7 days mostly waiting through E3 |
| 8 | [8-fallback/](./8-fallback/README.md) | Deterministic emergency template + retry-and-fallback wiring in Node-RED | ~30 min one-off |
| 9 | [9-retrain/](./9-retrain/README.md) | Monthly cadence + Ollama tag versioning + rollback playbook | ongoing |

## Recommended sequencing

1. **Phase 6 deploy** to one host (NUC *or* Mac mini — pick whichever you're trying first). Don't change the HA Assist default yet. Verify the Ollama agent works when manually invoked from HA Developer Tools.
2. **Phase 8 fallback first**, before any cutover. The emergency template must exist before you remove Gemini's safety net.
3. **Phase 7 eval gate**, in order:
   - E1 structural — automated, fast.
   - E2 LLM-as-judge — costs ~€2-5 on Gemini, automated.
   - E3 shadow week — 5-7 days reading both messages every morning. Don't shortcut this.
   - E4 canary install — only after you've decided to cut over.
4. **Cutover** — flip HA's daily script to call `aula_local` instead of the Gemini agent.
5. **Phase 9 retrain** — re-enter once a month.

## "Done" checklist for the cutover gate

- [ ] Phase 6 healthcheck passes from HA's network.
- [ ] HA's MCP server entities are exposed to the Ollama agent (verified by manual `conversation.process` returning sensible Danish + at least one tool call).
- [ ] Phase 8 emergency template fires correctly when Ollama is stopped.
- [ ] E1 grammar ≥ 95% AND HTML ≥ 95% on Q4 GGUF.
- [ ] E2 mean ≥ 4.0 AND min ≥ 3 on 30 examples.
- [ ] E3 shadow week: 5 consecutive days with at most trivial differences from Gemini, including at least 3 days of real signal (non-empty Aula).
- [ ] E4 canary automation installed AND tested by manually firing the revert event.

After all eight boxes check, flip the agent_id in your daily script and watch the first morning.

## After cutover

The first 3 days post-cutover are the highest-risk window — watch your phone closely each morning. By day 5 with no incidents, the canary is your monitor and you can stop watching actively.

## What to do if you change your mind

Per-step rollback is available at every layer:

- **Bad daily output today** → E4 canary auto-reverts to Gemini.
- **Bad day, no canary trip** → manually flip `input_select.aula_active_agent` to "gemini" in HA, or change the agent_id in your daily script.
- **Decided this is all a bad idea** → leave the Ollama integration installed, switch back to Gemini, stop running new training cycles. Captured data and the GGUF are inert.

## Files in this section

Each phase folder has its own README that explains its files. Master index:

```
stage-3-use-model/
├── 6-deploy/         ollama-nuc.md, ollama-mac-mini.md, ha-assist-swap.md, healthcheck.sh
├── 7-eval/           e1-structural.py, e2-llm-judge.py, e3-shadow-week.md, e4-canary.yaml
├── 8-fallback/       emergency-template.ts, retry-and-fallback.md
└── 9-retrain/        cutover-checklist.md
```
