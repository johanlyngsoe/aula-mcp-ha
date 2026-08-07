# Ollama on Mac mini (Apple Silicon)

Metal-accelerated host. Goal: sub-minute notifications.

## Install

```bash
brew install ollama
brew services start ollama
```

Or from https://ollama.com if you don't use brew.

## Tune

Apple Silicon defaults are usually fine, but for a long-context tool-calling task:

```bash
# Per-user override (~/.zshrc or LaunchAgent env file)
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
launchctl setenv OLLAMA_KEEP_ALIVE 24h
launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
launchctl setenv OLLAMA_NOPRUNE 1
launchctl setenv OLLAMA_FLASH_ATTENTION 1   # ~15-25% faster on Apple Silicon

brew services restart ollama
```

`OLLAMA_FLASH_ATTENTION=1` is safe on M-series and gives a real speedup at long context. On Intel Macs leave it off.

### Context window

The `config/Modelfile` `num_ctx 16384` is fine on any Mac mini with 16 GB+. On an 8 GB Mac mini, drop to 12288 to avoid swap.

## Expected throughput

| Chip | 1500-token completion | Daily run |
|---|---|---|
| M1 / M2 base | ~30 s | 1-2 min |
| M2/M3 Pro | ~15 s | <1 min |
| M4 / Pro / Max | ~10 s | ~30 s |

## Power / always-on

If the Mac mini is also your daily-use machine, set Ollama to unload after idle:

```bash
launchctl setenv OLLAMA_KEEP_ALIVE 5m
```

The model unloads after 5 min of inactivity; next call pays ~5 s cold-start latency. Worth it for power.

If it's a dedicated server, set `OLLAMA_KEEP_ALIVE=24h` so the model stays resident.

## Sleep / wake

System Preferences → Energy → "Prevent automatic sleeping when display is off" → ON. Otherwise the morning notification triggers wake-from-sleep and times out the first run.

## Network

By default Ollama binds only to localhost. To accept connections from HA on another box:

```bash
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
brew services restart ollama
```

Restrict to your LAN with macOS firewall (System Settings → Network → Firewall).

## Test

```bash
curl -s http://mini.local:11434/api/tags | jq .
curl -s http://mini.local:11434/api/generate -d '{"model":"aula:v1","prompt":"Sig hej.","stream":false}' | jq -r .response
```
