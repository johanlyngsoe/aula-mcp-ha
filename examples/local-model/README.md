# Local model for Aula daily notifications

A self-contained pipeline to replace your Gemini subscription with a locally hosted, LoRA-fine-tuned Qwen2.5-3B-Instruct model that emits multi-round tool calls against `aula-mcp` and generates the same Danish Telegram notifications you get today.

> **Status:** scaffolding + recipes. Scripts marked `[TODO]` are starting points you finish on first run; READMEs are complete.

---

## ⚠️ Privacy first — read before doing anything

Your traces contain children's names, school institution codes, teacher names, class schedules, and the contents of teacher messages (which sometimes include illness or behavioural notes). This data must not leave devices you control.

**Required setup before any capture or training:**

1. **HAOS** — capture writes to `/config/aula-train/`. `/config` is HAOS's protected dir; not synced to cloud.
2. **MacBook** — training corpus lives at `~/aula-train/`, **outside** iCloud Drive, Dropbox, OneDrive. Exclude from Time Machine:
   ```bash
   tmutil addexclusion ~/aula-train
   ```
3. **Git** — every data dir is in `.gitignore` (see repo root). Never `git add data/` or `*.gguf`.
4. **Gemini paid tier required** for Stage 1 historical replay. The free tier retains your data for training; the paid tier does not. Verify at https://ai.google.dev/pricing before running replay.
5. **Inference host** — the GGUF itself encodes learned associations but no raw names; safe on either NUC or Mac mini. Ollama telemetry off (`OLLAMA_NOPRUNE=1`).

---

## The three sections

The work splits into three sections, each a long-lived state you can sit in. You move forward when you decide; nothing forces you to keep going.

| Section | Subfolder | What you do | What changes in production |
|---|---|---|---|
| **1. Prepare training data** | [`stage-1-prepare-data/`](./stage-1-prepare-data/README.md) | Apply 3 additive patches to existing repo, record every daily Gemini run, replay ~6 months of Aula history | **Nothing**. Gemini keeps serving your daily notifications. Capture is silent logging. |
| **2. Train the model** | [`stage-2-train-model/`](./stage-2-train-model/README.md) | LoRA fine-tune on M1 Max, fuse, convert to GGUF, quantize | Nothing — happens entirely on your Mac. |
| **3. Use the model** | [`stage-3-use-model/`](./stage-3-use-model/README.md) | Deploy to Ollama on NUC / Mac mini, run the strict eval gate, wire fallback, cut over | After the eval gate passes: Ollama replaces Gemini as the active conversation agent. |

Each section's README tells you what's inside and what "done" looks like. You can park between sections for as long as you like — Section 1 in particular is a low-effort background activity that keeps populating your dataset for free.

## 👉 You are probably here

If you're starting from scratch and want to **keep using your current Gemini setup while quietly preparing training data**, go to:

> ### **[Section 1 — Prepare training data](./stage-1-prepare-data/README.md)**

Section 1 is intentionally non-disruptive. It adds logging hooks and runs a one-off historical replay. Gemini remains your daily notification agent the whole time. You can leave the project in this state for as long as you want — capture keeps growing your dataset every day automatically. Come back to Section 2 when you're ready to train.

---

## What this pipeline produces (when you finish all three sections)

A single artifact: `aula-qwen2.5-3b-lora.Q4_K_M.gguf` (~2 GB), registered with Ollama on either:
- **Intel NUC (i3, 8 GB RAM)** — minutes per notification, fine for once-daily.
- **Mac mini (Apple Silicon)** — seconds per notification via Metal.

HA's Ollama integration calls it the same way it calls Gemini today. The three prompt files in `examples/daily-overview-prompts/` are unchanged except for two tiny additive edits applied in Section 1.

---

## Prerequisites (for the whole project)

| Where | What |
|---|---|
| **HAOS** | Existing `aula-mcp` MCP server entity working with Gemini today. Node-RED preferred (lower-friction capture); plain HA YAML supported as alternative. |
| **MacBook (M1 Max, 64 GB)** | Python 3.11+, `mlx`, `mlx-lm`, `huggingface_hub`. Install via `pip install mlx mlx-lm`. Clone of `ggerganov/llama.cpp` for GGUF conversion. |
| **Inference host (NUC or Mac mini)** | Ollama (https://ollama.com). NUC: 8 GB RAM free, ~3 GB disk for the model + KV cache. Mac mini: macOS 13+, any chip M1+. |
| **API keys** | Paid Gemini API key for Section 1 replay + Section 3 LLM-as-judge eval. `GEMINI_API_KEY` env var. |

---

## Customization

| Want to | Edit |
|---|---|
| Change base model (e.g., Qwen2.5-7B on Mac mini only) | `config/.env.example` → `MODEL_ID`; rerun Section 2 |
| Change LoRA rank, learning rate, iterations | `config/lora.yaml` |
| Change context window | `config/Modelfile` (`PARAMETER num_ctx`); also `lora.yaml:seq` |
| Change replay window | Section 1 → 2-replay-history → `replay.ts --months N` |
| Skip eval layers (not recommended) | Section 3 → 7-eval README documents which gates can be relaxed |

---

## Things this pipeline does **not** do

- **No automatic CI**. Training runs are manual; that's intentional — you read the loss curve before fusing.
- **No multi-language support**. Output is Danish-only because the captured data is.
- **No streaming output**. Telegram doesn't need it; Ollama returns the full message and HA forwards it.
- **No multi-user**. Trained on your children, your school, your prompts. Sharing the GGUF would leak associations.

---

## See also

- The original Gemini prompts: [`../daily-overview-prompts/`](../daily-overview-prompts/)
- The MCP server tool registry: [`../../packages/mcp-server/src/tools.ts`](../../packages/mcp-server/src/tools.ts)
- The plan that drove this design: `/Users/madslundt/.claude/plans/help-me-plan-to-serene-castle.md`
