# Verify HAOS paths for capture + tracing

The MCP tracer and Node-RED capture both write to `/config/aula-train/` on HAOS. This doc verifies the dir exists, has correct ownership, and rotates old files.

## Create the directory

SSH into HAOS (or use the SSH & Web Terminal add-on) and run:

```bash
mkdir -p /config/aula-train
chmod 755 /config/aula-train
ls -ld /config/aula-train
```

Expected owner: `root:root` on a standard HAOS install (Node-RED runs as root in its container; the MCP server add-on similarly). If you've customised users, match the owner to whichever process writes the file.

## Confirm both writers can touch it

```bash
# From the same shell the Node-RED add-on uses:
touch /config/aula-train/.write-test && rm /config/aula-train/.write-test && echo OK

# From the aula-mcp add-on container (if running as an add-on rather than embedded):
docker exec addon_<aula-mcp-id> touch /config/aula-train/.write-test
```

## 90-day retention

Add a small cron-style automation to HAOS (or a host-cron equivalent) that deletes JSONL files older than 90 days. Example HA automation:

```yaml
automation:
  - alias: aula_train_rotate_90d
    trigger:
      platform: time
      at: "03:30:00"
    action:
      service: shell_command.aula_train_rotate

shell_command:
  aula_train_rotate: "find /config/aula-train -type f -name '*.jsonl' -mtime +90 -delete"
```

(Adjust if you keep more / less history — but past ~6 months becomes diminishing returns for retraining since teacher rosters and class compositions drift.)

## Disk impact

At the rates documented in `apply-mcp-tracer.md` (~1.2 MB/day worst case) plus Node-RED conversation logs (~5-30 KB/day), expect under 1.5 GB after 1 year. HAOS's `/config` partition is typically tens of GB; this is comfortable.

## Backup hygiene

If you use HA's built-in backup, **decide whether you want training data in those backups**:

- **Excluded (recommended)** — add `/config/aula-train/` to your backup-excludes in `configuration.yaml` if your backup add-on supports it, or move the dir to `/share/aula-train/` and adjust `AULA_MCP_TRACE_DIR` accordingly (HA Backups do not include `/share` by default).
- **Included** — only if your backup destination is itself fully under your control (encrypted at rest, off-cloud).

The default plan recommendation: keep training data out of backups; re-running B1 replay regenerates the bulk of it from Aula's own history if needed.
