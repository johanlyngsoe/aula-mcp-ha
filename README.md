# aula-mcp

[![CI](https://github.com/madslundt/aula-mcp-ha/actions/workflows/ci.yml/badge.svg)](https://github.com/madslundt/aula-mcp-ha/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Bun-≥%201.3-black?logo=bun)](https://bun.sh)
[![pnpm](https://img.shields.io/badge/pnpm-≥%2010-F69220?logo=pnpm)](https://pnpm.io)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-Streamable_HTTP-6B5BFF)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-209%20pass-brightgreen)](#development)

> **Fork of [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp)** — extended with Home Assistant and Docker Compose support.

**What this is — and what it is *not*:**

`aula-mcp` is a server that sits between an MCP client (LLM) and Aula — an interface, nothing more. **The LLM is not part of this project.** You choose your own client (Claude Code, Claude Desktop, ChatGPT, Cursor, Ollama, LM Studio, etc.), and it runs wherever it runs — in Anthropic/OpenAI's cloud, or locally if you use Ollama or similar.

**This project does not guarantee that your children's data stays local.** Whether the data remains local depends entirely on which client you connect — that is your own responsibility, not something `aula-mcp` can promise.

> ⚠️ **Use with care**
>
> Hobby experiment, no guarantees. This touches MitID and your children's school data — review the code (or have a developer friend do it) before connecting an LLM. Use at your own risk.

> ⚠️ **It is the client that sees the data — not the server**
>
> This server runs locally and does not forward anything on its own. **But the MCP client you connect — Claude, ChatGPT, another cloud LLM — receives everything it reads and sends it to the provider (Anthropic, OpenAI, etc.) to generate a response.** It is not "all local" just because the server is. That is how MCP works: the client reasons, the server fetches data.
>
> | | Where it goes |
> | --- | --- |
> | MitID credentials and OAuth tokens | Stay local — macOS Keychain or AES-256-GCM encrypted file. Only used to fetch data from Aula. |
> | The actual data (messages, weekly plans, children's names, etc.) | Sent to whichever MCP client you choose. Cloud LLM → provider's servers (typically USA). Local LLM → stays local. |
>
> **Want it 100% local?** Use a local LLM as the client: [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [llama.cpp](https://github.com/ggml-org/llama.cpp), Mistral via Hugging Face, etc. They all speak MCP and run on your own hardware.

TypeScript + Bun + Hono. Built on the shoulders of [`scaarup/aula`](https://github.com/scaarup/aula) (Python/Home Assistant). Still evolving — tools may change signature, commands may be renamed, and some vendor integrations have only been tested against one set of schools.

![Claude Code asking about next week's weekly plan](./docs/demos/claude-code.gif)

---

## Contents

- [What the server touches](#what-the-server-touches)
- [Getting started](#getting-started)
- [Connect to Claude Code (or claude.ai)](#connect-to-claude-code-or-claudeai)
- [Self-hosting](#self-hosting)
  - [Single binary on a Linux box](#option-1-single-binary-on-a-linux-box-pi-nas-old-laptop-cheap-vps)
  - [Behind an authenticated reverse proxy](#option-2-behind-an-authenticated-reverse-proxy-family-access-from-mobile)
  - [Docker Compose (Portainer / Home Assistant)](#option-3-docker-compose-portainer--home-assistant)
  - [Home Assistant Add-on](#option-4-home-assistant-add-on-coming-soon)
  - [VPS in Europe](#option-5-vps-in-europe-hetzner-coolify)
  - [Backup & key management](#backup--key-management)
- [What is in the manifest](#what-is-in-the-manifest)
- [CLI commands](#cli-commands)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Fixes from upstream Aula issues](#fixes-from-upstream-aula-issues)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [Privacy & legal](#privacy--legal)

---

## What the server touches

What `aula-mcp` itself does (and does not do). Where the data ends up afterwards is the client's domain — see the disclaimer above.

- **MitID credentials and OAuth tokens stay local.** macOS: Keychain (`security` CLI). Linux/Windows: AES-256-GCM encrypted file in `~/.config/aula-mcp/`. They never leave your machine.
- **The server only binds to `127.0.0.1`.** It refuses to bind to a non-loopback address unless you set `AULA_MCP_ALLOW_REMOTE=1`. Default: only programs on your own computer can reach it.
- **No telemetry, no third parties.** The program only talks to Aula's own servers (`api.aula.dk`, `login.aula.dk`), MitID (`nemlog-in.mitid.dk`), and the vendor APIs (EasyIQ, Meebook, etc. — if your school has them).
- **The MitID authentication goes through MitID's own infrastructure.** The protocol is rewritten in TypeScript, but the actual authentication (the QR code in the MitID app) happens as always between your device and nemlog-in.dk.
- **The `--debug` trace is opt-in and automatically redacted.** Cookies, OAuth codes, MitID payloads, M1 values, flowValueProof, access tokens, etc. are removed *before* anything is written to disk. Safe to attach to a GitHub issue.
- **Loopback-only = family can't reach the server from their own devices.** For multi-device household access, use a reverse proxy (see Self-hosting) or the Home Assistant integration.

---

## Getting started

Requires **[Bun](https://bun.sh) ≥ 1.3** and **[pnpm](https://pnpm.io) ≥ 10**. macOS or Linux.

```sh
git clone https://github.com/madslundt/aula-mcp-ha.git
cd aula-mcp-ha
pnpm install

# 1. Sanity check
pnpm typecheck && pnpm lint && pnpm test

# 2. First-time MitID login (QR code in the MitID app)
pnpm login

# 3. Health check of all Aula endpoints
pnpm doctor

# 4. Start the MCP server (http://127.0.0.1:7878/mcp)
pnpm mcp
```

Most CLI commands have a short alias: `pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`. For everything else, `pnpm aula <command>` forwards to the CLI (e.g. `pnpm aula transcript list`, `pnpm aula log --last 5`).

The `doctor` command walks through every read endpoint and reports status + response time for each. It is the quickest "does this actually work?" check:

![aula doctor walking through all endpoints](./docs/demos/doctor.gif)

`whoami` shows which identity your tokens belong to and which children are returned by `getProfilesByLogin`:

![aula whoami showing identity + children](./docs/demos/whoami.gif)

---

## Connect to Claude Code (or claude.ai)

### Claude Code

```sh
# 1. Run the server in one terminal window
pnpm mcp

# 2. Register the server with Claude Code (once only)
claude mcp add --transport http aula http://127.0.0.1:7878/mcp

# 3. In any Claude Code session, confirm it is connected
/mcp
```

Then just ask naturally — children's names are fuzzy-matched against the `discover` manifest, no need to know their ID:

> *what is on the weekly plan next week for theo*

Claude calls `aula_discover` once, picks the right weekly plan vendor for your school from `detectedWidgets`, and responds in your language.

### Claude Desktop

Drop the snippet from [`examples/claude-config/claude-desktop.json`](./examples/claude-config/claude-desktop.json) into `~/Library/Application Support/Claude/claude_desktop_config.json`.

### claude.ai (web)

The web UI requires a public HTTPS URL — `127.0.0.1` does not work because the connection is made server-side from Anthropic's cloud. For a quick test:

```sh
cloudflared tunnel --url http://127.0.0.1:7878
# → https://<random>.trycloudflare.com — paste with /mcp at the end
```

> ⚠️ **The tunnel URL is publicly accessible while it is running** — if someone guesses it, they can reach your Aula tokens. Fine for a quick demo, but do not leave it open. For a permanent setup, see the next section.

### Home Assistant (Assist / Voice pipeline)

The server supports both the Streamable HTTP transport (`/mcp`) and the legacy SSE dialect (`/sse`). Home Assistant's official [`mcp` client integration](https://www.home-assistant.io/integrations/mcp/) uses SSE — point it at `http://<ha-host>:7878/sse` and Assist plus your chosen LLM (Anthropic / OpenAI / Ollama) will have access to all `aula.*` tools.

**Node-RED automation example** — ask an LLM to summarise Aula updates and notify the family:

In Node-RED, add a `call service` node (from `node-red-contrib-home-assistant-websocket`):
- **Domain:** `conversation`
- **Service:** `process`
- **Data:**
  ```json
  {
    "agent_id": "your-ha-agent-id",
    "text": "Check Aula. Are there any new messages, cancelled lessons, homework or important notes from school? Give a short summary.",
    "language": "en"
  }
  ```

Connect the response (`msg.payload.response.speech.plain.speech`) to a notification node. Schedule with an inject node (e.g. every morning at 07:00).

---

## Self-hosting

If you want the server running without keeping your laptop open, there are several options. All of them keep the *server* local — where the client runs is still a separate choice (see the top disclaimer).

### Option 1: Single binary on a Linux box (Pi, NAS, old laptop, cheap VPS)

The simplest path. Compile to a single binary and run it under systemd.

```sh
# Build a standalone binary (~50 MB)
bun build --compile --outfile dist/aula-mcp packages/mcp-server/src/server.ts

# Copy to your server (Pi, NAS, VPS)
scp dist/aula-mcp aula:/usr/local/bin/aula-mcp
```

**Tokens on the server** — two paths, choose the one that fits:

A. *Log in directly on the server via SSH.* QR codes are rendered in the SSH session, scan with the MitID app on your phone. Works on any machine you can SSH into with a normal TTY.

```sh
ssh aula
aula login
```

B. *Export tokens from your Mac (or wherever you are already logged in).* The macOS Keychain cannot be moved between machines, so `aula tokens export` re-encrypts them into a portable file bundle.

```sh
# On your Mac
aula tokens export ~/aula-bundle

# Move to the server — bundle contains live credentials, treat like passwords.
# SSH encrypts in transit.
scp ~/aula-bundle/tokens.json ~/aula-bundle/.key \
    aula:/var/lib/aula-mcp/

# Delete the bundle on your Mac when done
rm -rf ~/aula-bundle
```

Example `systemd` unit at `/etc/systemd/system/aula-mcp.service`:

```ini
[Unit]
Description=aula-mcp server
After=network.target

[Service]
Type=simple
User=aula
ExecStart=/usr/local/bin/aula-mcp
Environment=AULA_MCP_PORT=7878
Environment=AULA_MCP_HOST=127.0.0.1
Environment=AULA_MCP_DIR=/var/lib/aula-mcp
Environment=AULA_MCP_KEY=<a long hex string or passphrase>
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now aula-mcp`. Check `journalctl -u aula-mcp -f` for logs.

### Option 2: Behind an authenticated reverse proxy (family access from mobile)

The server only binds to `127.0.0.1` by default. For the family (or yourself on your phone via VPN) to reach it, put an authenticated reverse proxy in front. Example with [Caddy](https://caddyserver.com):

```caddyfile
aula.yourhome.dk {
    basicauth {
        family $2a$14$<bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:7878
}
```

`AULA_MCP_HOST` stays as `127.0.0.1` — Caddy handles TLS, basic auth, and rate limiting. It is Caddy that is on the public internet, not the MCP server itself.

> ⚠️ If you *must* expose the server directly (skipping the proxy layer) you need to explicitly set `AULA_MCP_ALLOW_REMOTE=1` — that is a controlled, intentional action, not an accident.

### Option 3: Docker Compose (Portainer / Home Assistant)

The repo ships a `Dockerfile` and `docker-compose.yml` so you can build and run with a single command. No runtime cloning, no installing Bun on top of Node — the image is self-contained and starts in seconds.

**1. Clone the repo and build**

```sh
git clone https://github.com/madslundt/aula-mcp-ha.git
cd aula-mcp-ha
docker compose up -d --build
```

In Portainer: add a new stack, paste the contents of `docker-compose.yml`, and click Deploy. The image is built from the `Dockerfile` in the repo root.

**`docker-compose.yml`** (already in the repo, adjust the volume path if needed):

```yaml
version: "3.9"
services:
  aula-mcp:
    build: .
    container_name: aula-mcp
    environment:
      # Set AULA_MCP_KEY to a passphrase to encrypt the token store:
      # - AULA_MCP_KEY=your-secret-passphrase
    ports:
      - "7878:7878"
    volumes:
      # HA OS / Portainer path — change to ./config:/config for a local setup
      - /mnt/data/supervisor/share/aula-mcp:/config
    restart: unless-stopped
```

All other environment variables (`AULA_MCP_HOST`, `AULA_MCP_ALLOW_REMOTE`, `AULA_MCP_NO_KEYCHAIN`, etc.) are set to sensible defaults in the `Dockerfile` and do not need to be repeated here.

**2. First-time MitID login**

After the container is running, exec into it and complete the login flow. The QR code appears in the terminal — scan it with the MitID app on your phone:

```sh
# CLI / Portainer "Exec console":
docker exec -it aula-mcp bun apps/cli/src/index.ts login
```

Tokens are written to the mounted volume (`/config`) and survive container restarts and image rebuilds.

**3. Verify**

```sh
curl http://localhost:7878/healthz
# → {"ok":true,"name":"aula-mcp"}

docker exec -it aula-mcp bun apps/cli/src/index.ts doctor
```

**Updating to a newer version**

```sh
cd aula-mcp-ha
git pull
docker compose up -d --build
```

### Option 4: Home Assistant Add-on (recommended for HA users)

The cleanest option if you run Home Assistant OS or Supervised. The add-on shows up in **Settings → Add-ons**, is managed by the HA Supervisor (watchdog, auto-restart), and has a config UI — no Portainer needed.

**Install in 3 steps:**

1. **Add this repository to HA:**
   - Go to **Settings → Add-ons → Add-on Store**
   - Click the three-dot menu (⋮) → **Repositories**
   - Add `https://github.com/madslundt/aula-mcp-ha` and click **Add**

2. **Install the add-on:**
   - Refresh the page — "Aula MCP" appears in the store
   - Click it → **Install** (HA builds the image from the Dockerfile; takes ~2 min on first install)
   - Optionally set `aula_mcp_key` in the **Configuration** tab to encrypt the token store
   - Click **Start**

3. **First-time MitID login:**
   - Open the HA **Terminal & SSH** add-on (or use the web terminal)
   - Run:
     ```sh
     docker exec -it $(docker ps --filter name=aula_mcp -q) \
       bun /app/apps/cli/src/index.ts login
     ```
   - Scan the QR code with the MitID app — tokens are saved to the add-on's `/data` volume

**Connect HA's MCP integration:**
- Go to **Settings → Integrations → Add → Model Context Protocol**
- SSE URL: `http://homeassistant.local:7878/sse`

**Updating:** Go to the add-on page → **Update** button. HA rebuilds the image from the latest source.

> **Compared to Portainer Docker Compose:**
> The add-on is managed entirely within HA — no separate tool needed, config lives in the HA UI, and the Supervisor handles restarts and watchdog monitoring automatically.

### Option 5: VPS in Europe (Hetzner, Coolify)

If you already have a European VPS (Hetzner, Scaleway, OVH) and a domain — it is just a `git clone` + `bun install` + systemd unit as in Option 1.

### Backup & key management

- **Token store**: keep an encrypted copy of `~/.config/aula-mcp/tokens.json` + `.key` (or Keychain export on macOS). If you lose them you have to log in again — not a disaster, but annoying.
- **AULA_MCP_KEY**: if you use the file backend in production, set a strong `AULA_MCP_KEY` (env var) and do not commit it. If you rotate it, you will need to log in again.
- **New Aula versions**: Aula bumps their API version 1-2 times per year. `aula-mcp` probes the new version automatically on the next call (no manual work), but keep an eye on release notes for breaking changes.

---

## What is in the manifest

Agents call `aula_discover` once and reuse the result for the rest of the session. The manifest tells the agent who the user is, which children can be acted on, which third-party widgets the schools have configured, and which MCP tools to call:

![aula_discover manifest pretty-printed](./docs/demos/discover.gif)

Shape:

```ts
{
  user: { name, username, identityName? },
  children: [{ id, name, userId?, institution: { id, name?, code? } }],
  apiVersion: 23,
  tokens: { expires_at, seconds_remaining },
  detectedWidgets: ['0001', '0029', '0030'],   // from Aula's pageConfiguration
  capabilities: {
    profiles:      { summary, tools: ['aula_profiles_list'] },
    presence:      { summary, tools: ['aula_presence_today'] },
    calendar:      { summary, tools: ['aula_calendar_events'] },
    messages:      { summary, tools: ['aula_messages_list_threads', 'aula_messages_get_thread'] },
    notifications: { summary, tools: ['aula_notifications_list'] },
    posts:         { summary, tools: ['aula_posts_list'] },
    ugeplan:       { summary, tools: ['aula_ugeplan_easyiq'] },          // only the detected vendor
    opgaver:       { summary, tools: ['aula_opgaver_minuddannelse'] },
    ugebrev:       { summary, tools: ['aula_ugebrev_minuddannelse'] },
    huskelisten:   { summary, tools: ['aula_huskelisten_systematic'] }
  },
  usage: {
    cache, nameResolution, pickOne, timeWindows, language
  },
  rawRequestEnabled: false
}
```

`capabilities[area].tools[0]` is always the right tool to call — when a school's widgets are detected, only the matching vendor is listed, so the agent does not fumble across multiple providers. The inline `usage` block tells the agent how to behave (cache the manifest, fuzzy-match children's names, default to Europe/Copenhagen, respond in the user's language).

---

## CLI commands

```
aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
aula status [--json]
aula whoami [--json]
aula doctor [--json] [--verbose]
aula log [--last N] [--json]
aula transcript {list|view <file>|prune} [--json] [--keep N] [--dry-run]
aula logout
aula --help
```

| Command | What it does |
| ------- | ------------ |
| `aula login` | Runs the full MitID flow (APP method is default — scan QR with the MitID app). Stores tokens. `--debug` captures a sanitised wire transcript so errors are diagnosable. |
| `aula status` | Shows whether tokens exist, their expiry time, and the active identity. Does not contact the network. Exit code 1 if no tokens. |
| `aula whoami` | Loads tokens (refreshes if needed), calls `getProfilesByLogin` + `getProfileContext`. Smoke test of the full auth + client pipeline. |
| `aula doctor` | Walks through every read endpoint and reports per-call status with response time. The quickest "does this work?" check. `--verbose` dumps the wire transcript inline on failure. |
| `aula log` | Most recent login attempts (success/failure, timestamps, error class). |
| `aula transcript` | Inspect captured `--debug` transcripts; `prune` keeps the most recent N (default 10). |
| `aula logout` | Deletes the stored tokens. The encryption key is kept so the next login reuses it. |

Full help with examples: `pnpm aula --help`

![aula --help](./docs/demos/help.gif)

---

## Configuration

### Where tokens are stored

| Platform | Default | Override |
| -------- | ------- | -------- |
| macOS | Keychain (`security` CLI; service `aula-mcp`, account `tokens`) | `AULA_MCP_NO_KEYCHAIN=1` falls back to the file backend |
| Linux / Windows / Docker | AES-256-GCM encrypted file in `~/.config/aula-mcp/tokens.json` | `AULA_MCP_KEY=<hex\|passphrase>` for the encryption key (otherwise generated in `~/.config/aula-mcp/.key`, `chmod 600`) |

### Server environment variables

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `AULA_MCP_PORT` | `7878` | Bind port. |
| `AULA_MCP_HOST` | `127.0.0.1` | Bind interface. Refuses non-loopback unless `AULA_MCP_ALLOW_REMOTE=1`. |
| `AULA_MCP_DIR` | `~/.config/aula-mcp` | Config directory (file backend + transcripts + login log). |
| `AULA_MCP_NO_KEYCHAIN` | off | Set to `1` to disable macOS Keychain and use the file backend instead. Required in Docker. |
| `AULA_MCP_RAW=1` | off | Enables the `aula_raw_request` escape-hatch tool. |
| `AULA_MCP_LOG=1` | off | Verbose console logs from the auth/client layers. |
| `AULA_MCP_ALLOW_REMOTE=1` | off | Allows binding to non-loopback addresses (e.g. behind a reverse proxy or in Docker). |

### Wire transcripts

`--debug` mode tees a JSONL transcript of every HTTP request/response to `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. Cookies, OAuth/SAML payloads, MitID auth codes, passwords, M1, flowValueProof, `access_token` query parameters, and other secret fields are all redacted (`<redacted N chars>`). The transcript is safe to attach to a GitHub issue.

`aula transcript view <file>` pretty-prints one of them.

---

## Architecture

```
packages/
  aula-auth/    — MitID + 3072-bit SRP-6a + OAuth/SAML chain + token store + wire trace
  aula-client/  — Aula REST API + version probing + integration plugins
  mcp-server/   — Hono + @modelcontextprotocol/sdk + aula_discover + 11 capability tools
apps/
  cli/          — aula login/status/whoami/doctor/log/transcript/logout
```

Cross-package imports use the workspace name (`@aula-mcp/aula-auth`); Bun resolves `.ts` directly, so there is no build step in dev. `tsc -p tsconfig.json --noEmit` runs in CI for type checking.

| Layer | Status | Notes |
| ----- | ------ | ----- |
| `@aula-mcp/aula-auth` | ✅ unit-tested + live-verified | MitID APP + CODE_TOKEN + PASSWORD; macOS Keychain or AES-GCM file. |
| `@aula-mcp/aula-client` | ✅ unit-tested | Native Aula API + EasyIQ / EasyIQ SkolePortal / Meebook / Min Uddannelse / Systematic plugins. |
| `@aula-mcp/mcp-server` | ✅ unit-tested + live-verified with Claude Code | Streamable HTTP transport, stateful session. Single-user, loopback by default. |
| `apps/cli` | ✅ unit-tested | QR rendering, debug transcripts, JSONL login log. |

`@aula-mcp/aula-auth` and `@aula-mcp/aula-client` only use Web standards + `node:crypto` + `node:child_process` — they run on Node ≥ 20 as well as Bun. The MCP server uses `Bun.serve` and is Bun-only. The CLI uses Bun's TS support and ships via `bun build --compile`. To use the libraries from a Node script, see [`examples/script/`](./examples/script/).

Detailed design rationale: [docs/architecture.md](./docs/architecture.md).

---

## Fixes from upstream Aula issues

A few issues from `scaarup/aula`'s tracker that are addressed here:

| Upstream issue / PR | What the code does |
| ------------------- | ------------------ |
| [#311](https://github.com/scaarup/aula/issues/311) — sensor dies when widget JWT expires | `WidgetTokenManager.withRetry` detects `{"message":"JWT-Token expired..."}` (and 401/403) and refreshes once before retry. |
| [#246, #248](https://github.com/scaarup/aula/issues/246) — Aula API version drifts (v22 → v23 mid-life) | `AulaClient` probes versions lazily, retries once on 410, fires `onApiVersionChanged` on bumps. |
| [#310](https://github.com/scaarup/aula/issues/310) — RelayState missing in Level-3 SAML response | `extractSamlForm` returns `hadRelayState: false` and an empty string instead of throwing. |
| [#306, #287](https://github.com/scaarup/aula/issues/306) — `post-broker-login` returns 200 with a confirmation form instead of 302 | `detectConfirmationForm` finds `button#confirmation-button`, submits its form, and continues. |
| [#290, #351](https://github.com/scaarup/aula/issues/351) — `password`/`token` required for auth methods that don't need them | `AulaLoginOptions` only requires fields for the selected `method`. The APP method does not need a password. |
| [PR #352](https://github.com/scaarup/aula/pull/352) — EasyIQ SkolePortal (widget 0128) | Implemented as `EasyIqSkoleportalClient` + `aula_ugeplan_easyiq_skoleportal` MCP tool. Per-child auth + Danish entity decode. |
| Sensitive messages (`status.code` 403) | Surfaced as typed `AulaStepUpRequiredError`; MCP tool returns structured `step_up_required` JSON instead of empty data. |

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `aula login` hangs after username prompt | MitID app not opened yet, or QR codes not rendered (terminal too narrow). Make sure the terminal is ≥ 80 columns. |
| `Login failed: MitID initialize failed (status …)` | nemlog-in.mitid.dk is unavailable or returned an error. Re-run with `--debug` and inspect the transcript. |
| `Login failed: APP poll error: …` | The MitID app rejected or cancelled. Check that the MitID app is logged in to your account. |
| `Login failed: appProve failed (status …)` | Rare — MitID rejected the SRP proof. Re-run with `--debug` and inspect `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. |
| `aula whoami` → `step_up_required` for messages | A specific thread is sensitive (Aula returns 403). Run `aula login` again to re-establish a step-up session, then try again. |
| `aula doctor` says `Aula API v22 → 410` | The API version has been bumped. Run `aula doctor` again — `AulaClient` probes ahead and remembers. |
| `aula status` shows `expired N min ago` | Tokens have expired since last use. Any read call (or `aula doctor`) will refresh them automatically. |
| MCP server: `Refusing to bind to non-loopback address` | You have set `AULA_MCP_HOST` to `0.0.0.0` or similar. The server is single-user; anyone who can reach `/mcp` becomes you. Set `AULA_MCP_ALLOW_REMOTE=1` if you understand the implications. |
| Docker: tokens lost on container restart | Mount a volume to `AULA_MCP_DIR` (e.g. `-v ./config:/config`). Also make sure `AULA_MCP_NO_KEYCHAIN=1` is set. |
| Docker: `Cannot find module` errors | The container ran `bun install` but the volume mount overwrote `node_modules`. Add a named volume for `/app/node_modules` or install after mounting. |

When something fails, the JSONL transcript at `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl` (after `--debug`) is the first place to look. `aula transcript view <file>` pretty-prints it.

---

## Development

```sh
pnpm install          # install everything
pnpm typecheck        # tsc -p tsconfig.json --noEmit
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # bun:test suites (209 cases)
pnpm test:watch       # re-run on change
```

All other top-level scripts: `pnpm aula <cmd>`, `pnpm mcp`, plus per-command shortcuts (`pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`).

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repo layout, conventions, and a guide to adding integration plugins. Contributors agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: please write to **info@casperjuel.dk** instead of opening a public issue — see [SECURITY.md](./SECURITY.md).

---

## Privacy & legal

MitID credentials and OAuth tokens stay on your machine. The server only binds to `localhost` by default. No telemetry. The wire trace is opt-in (`--debug`) and every known-secret field is redacted before anything is written to disk.

The actual data (messages, weekly plans, children's names, etc.) is passed on to whichever MCP client you connect. Where the client sends it is the client's concern, not the server's — see the top disclaimer.

Use this project for your own children's data — log in as yourself with your own MitID; do not use it to access anyone else's account.

> **Disclaimer.** This project is not affiliated with, endorsed by, or sponsored by KMD A/S, Netcompany A/S, or the Aula consortium. *Aula* is a trademark belonging to its respective owner; the name is used here solely to identify what this software communicates with.

---

## Credits

This project is a fork of [**Casperjuel/aula-mcp**](https://github.com/Casperjuel/aula-mcp) by [@Casperjuel](https://github.com/Casperjuel). All core work — the MitID authentication flow, the Aula API client, the MCP server, and the CLI — comes from that project. This fork adds Home Assistant / Docker Compose documentation and a dynamic widget token fix.

`aula-mcp` itself is built on the shoulders of [**scaarup/aula**](https://github.com/scaarup/aula) (Python / Home Assistant integration) by [@scaarup](https://github.com/scaarup), which reverse-engineered the Aula API and the MitID flow that this TypeScript port is based on.

---

## License

[MIT](./LICENSE).
