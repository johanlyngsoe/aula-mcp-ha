# Monthly retrain — one-page checklist

Date: _______________________ Tag to publish: aula:v____

## Data

- [ ] Pull latest captures: `rsync HAOS:/config/aula-train/ ~/aula-train/raw/`
- [ ] Phase 2 replay last 2 months: `bun run replay.ts --months 2`
- [ ] Append hand-curated edge cases: `cat ~/aula-train/manual/edge-cases.jsonl >> ~/aula-train/raw/pairs.jsonl`
- [ ] Phase 3 prepare with manual weighting: `python prepare.py --weight-manual 3`
- [ ] Eyeball split sizes: `wc -l ~/aula-train/splits/*.jsonl`

## Train

- [ ] Bump seed in `config/lora.yaml` (e.g., 42 → 43 → 44)
- [ ] Phase 4 train: `./train.sh` (1-2 h)
- [ ] Stop when validation loss plateaus or at 600 iters
- [ ] Fuse: `./fuse.sh`
- [ ] Phase 4 eval-e1: must hit ≥ 95% grammar + 95% HTML

## Convert

- [ ] Phase 5 to-hf + to-gguf + quantize
- [ ] Sanity-check `model-q4_k_m.gguf` size (~2 GB)

## Eval

- [ ] E1 vs MLX fused — gate ≥ 95%
- [ ] E1 vs Q4 GGUF — within 2% of fused
- [ ] E2 LLM-as-judge — mean ≥ 4.0, min ≥ 3
- [ ] A/B vs current prod tag — new model wins on margin OR equivalent

## Deploy

- [ ] Copy GGUF to inference host
- [ ] `ollama create aula:vN -f Modelfile` on host
- [ ] `healthcheck.sh host:11434` — passes
- [ ] Manually test from HA Developer Tools — sensible response
- [ ] Update HA Ollama integration → model field → `aula:vN`
- [ ] Validator pass-rate sensor reset to 1.0 (E4 won't trip on stale data)
- [ ] First daily run with new tag — eyeball the Telegram output

## Watch

- [ ] Check E4 canary daily for the first 3 days
- [ ] Compare pass rate at 7 days vs vN−1 baseline
- [ ] If degraded: rollback (HA → input_select.aula_active_agent → ollama vN−1; or `ollama tag aula:vN-1 aula:current` + change integration model)

## Tidy

- [ ] Keep last 3 tags resident: `ollama rm aula:vN-4` if exists
- [ ] Archive splits: `mv ~/aula-train/splits ~/aula-train/archive/splits-vN`
- [ ] Update CHANGELOG.md in `9-retrain/` with notes on this release

## Rollback (if needed)

```bash
ssh host "ollama list | grep aula"
# Pick previous tag, e.g. aula:v3
# In HA: Settings → Devices → Ollama integration → Configure → Model → aula:v3
# Reload integration. Daily runs now use the previous version.
```

No data is lost on rollback — captures continue accumulating regardless of which tag serves production.
