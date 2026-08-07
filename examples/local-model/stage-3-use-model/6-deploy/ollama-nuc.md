# Ollama on Intel NUC (i3, 8 GB)

CPU-only host. Goal: keep the model under 4 GB resident with 4 GB headroom for OS + tool-call results coming back as conversation history.

## Install

If the NUC runs a recent Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
```

If the NUC runs HAOS rather than vanilla Linux (which is uncommon for i3 NUCs but possible), prefer running Ollama as an HA add-on or in a Docker container side-by-side:

```bash
docker run -d \
  --restart=always \
  -p 11434:11434 \
  -v /opt/aula-ollama:/root/.ollama \
  --name ollama \
  ollama/ollama
```

## Tune for an i3

Ollama's defaults assume more cores than you have. Lower:

```bash
sudo systemctl edit ollama
```

Append:

```
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=24h"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NOPRUNE=1"
```

Restart: `sudo systemctl restart ollama`.

### Per-model parameters

The `config/Modelfile` already sets `num_ctx 16384`. If you observe excessive paging or OOM, drop to 12288:

```Modelfile
PARAMETER num_ctx 12288
```

Threads: leave Ollama's default (uses all physical cores). i3-with-HT typically reports 4 logical CPUs; setting `OLLAMA_NUM_THREAD=2` is sometimes faster than 4 because of contention. Measure empirically:

```bash
time ollama run aula:v1 'Sig hej på dansk.' --verbose
# Compare with OLLAMA_NUM_THREAD=2 in env vs OLLAMA_NUM_THREAD=4.
```

## Expected throughput

| Operation | Wall clock |
|---|---|
| Cold start (load model into RAM) | ~30 s |
| 1500-token completion | ~5 min |
| Daily run with 8 tool calls + final response | 8-15 min |

If a daily run consistently exceeds 20 min, reduce `num_ctx` further or move to Phase 5 Q5_K_M (which is faster surprisingly — sometimes — because of fewer matmul stages).

## Disk

| Path | What | Size |
|---|---|---|
| `~/.ollama/models/` | model + manifest | ~2.5 GB (Q4_K_M + 64MB metadata) |
| `~/.ollama/history/` | command history | <10 MB |

## Network

Open `:11434` to the HA host's network only:

```bash
sudo ufw allow from <HA_HOST_IP> to any port 11434
```

Do **not** expose Ollama to the public internet — there's no auth on its API.

## Logs

```bash
journalctl -u ollama -f
```

## Test

```bash
curl -s http://nuc.local:11434/api/tags | jq .
# expect: {"models":[{"name":"aula:v1", ...}]}

curl -s http://nuc.local:11434/api/generate \
  -d '{"model":"aula:v1","prompt":"Sig hej.","stream":false}' | jq -r .response
# expect: "Hej!" or similar greeting
```
