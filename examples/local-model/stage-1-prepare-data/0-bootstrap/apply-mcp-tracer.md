# Patch: Tool-call tracer in `aula-mcp`

## Why

We need a JSONL log of every MCP tool call (name, args, result, duration) plus the SSE session ID so we can join captures to Node-RED prompt logs. The existing `Logger` interface in `aula-context.ts` is only wired up for startup/error events; we add a separate trace channel that's silent unless `AULA_MCP_TRACE_DIR` is set.

## Files affected

- `packages/mcp-server/src/setup.ts` — wraps `registerTools` so each tool call is traced.
- `packages/mcp-server/src/tool-tracer.ts` — **new** file, the tracer itself.
- `packages/mcp-server/src/server.ts` — pass `sessionId` into `createMcpApp({ logger, sessionId })`.
- `packages/mcp-server/src/server-stdio.ts` — pass a stable `sessionId` (e.g., `stdio-${pid}`).
- `packages/mcp-server/package.json` — no new deps; `node:fs/promises` + `node:path` only.

## New file: `packages/mcp-server/src/tool-tracer.ts`

```ts
/**
 * Optional JSONL trace of MCP tool calls.
 * Enabled only when AULA_MCP_TRACE_DIR is set. Silent otherwise.
 * Writes one line per call to <dir>/trace-YYYY-MM-DD.jsonl. Daily rotation.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ToolTracerOptions {
  dir: string;
  sessionId?: string;
}

interface TraceRecord {
  ts: string;
  sessionId: string;
  tool: string;
  args: unknown;
  result: unknown;
  duration_ms: number;
  ok: boolean;
  error?: string;
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function writeRecord(dir: string, record: TraceRecord): Promise<void> {
  const file = path.join(dir, `trace-${dayStamp()}.jsonl`);
  await appendFile(file, JSON.stringify(record) + '\n', 'utf-8');
}

/**
 * Wraps `server.registerTool` so every call is appended to a JSONL trace.
 * Use the returned `server` object exactly as you would the original.
 */
export function withToolTracer(server: McpServer, options: ToolTracerOptions): McpServer {
  let dirReady: Promise<void> | null = null;
  const ensureDir = async () => {
    if (!dirReady) dirReady = mkdir(options.dir, { recursive: true }).then(() => undefined);
    await dirReady;
  };

  const originalRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, spec: any, handler: any) => {
    const wrapped = async (args: unknown, extra: unknown) => {
      const t0 = Date.now();
      let ok = true;
      let error: string | undefined;
      let result: unknown;
      try {
        result = await handler(args, extra);
        return result;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        // Fire-and-forget; never throws upward.
        void (async () => {
          try {
            await ensureDir();
            await writeRecord(options.dir, {
              ts: new Date().toISOString(),
              sessionId: options.sessionId ?? 'unknown',
              tool: name,
              args,
              result: ok ? result : undefined,
              duration_ms: Date.now() - t0,
              ok,
              ...(error ? { error } : {}),
            });
          } catch {
            // Tracer failures must never affect tool semantics.
          }
        })();
      }
    };
    return originalRegister(name, spec, wrapped);
  };
  return server;
}
```

## Patch: `packages/mcp-server/src/setup.ts`

Add the import and wrap the server before `registerTools`:

```ts
import { withToolTracer } from './tool-tracer.ts';

export interface McpAppOptions {
  logger: Logger;
  sessionId?: string;
}

export function createMcpApp({ logger, sessionId }: McpAppOptions): McpApp {
  const context = new AulaContext({ logger });
  let mcp = new McpServer(
    { name: 'aula-mcp', version: '0.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const traceDir = process.env.AULA_MCP_TRACE_DIR;
  if (traceDir) {
    mcp = withToolTracer(mcp, { dir: traceDir, sessionId });
  }

  registerTools(mcp, context);
  return { mcp, context };
}
```

## Patch: `packages/mcp-server/src/server.ts`

Pass the per-session sessionId into `createMcpApp`. Find the line (around 104):

```ts
const sessionApp = createMcpApp({ logger });
```

Replace with:

```ts
const sessionApp = createMcpApp({ logger, sessionId });
```

The `sessionId` variable is already in scope from the surrounding SSE session setup.

## Patch: `packages/mcp-server/src/server-stdio.ts`

Find:

```ts
const { mcp } = createMcpApp({ logger });
```

Replace with:

```ts
const { mcp } = createMcpApp({ logger, sessionId: `stdio-${process.pid}` });
```

## Verification

```bash
# 1. No-op when AULA_MCP_TRACE_DIR is unset
bun packages/mcp-server/src/server-stdio.ts &
# Drive any tool call. Then:
test ! -d /tmp/aula-trace && echo 'OK: no trace dir created'
kill %1

# 2. Trace appears when env set
mkdir -p /tmp/aula-trace
AULA_MCP_TRACE_DIR=/tmp/aula-trace bun packages/mcp-server/src/server-stdio.ts &
# Drive a tool call. Then:
cat /tmp/aula-trace/trace-*.jsonl
# Expect one JSON line per call with the shape documented above.
```

## Rollback

```bash
git revert <commit>
rm -rf /config/aula-train  # or wherever AULA_MCP_TRACE_DIR pointed
```

## Notes on disk usage

A typical daily run emits ~8 tool calls × ~5-50 KB of result data = 40-400 KB/day per kind × 3 kinds = up to ~1.2 MB/day. At that rate the daily JSONL grows ~36 MB/month. The README's `verify-haos-paths.md` documents a 90-day retention sweep.
