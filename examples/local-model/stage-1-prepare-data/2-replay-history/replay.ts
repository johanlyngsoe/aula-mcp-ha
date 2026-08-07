/**
 * Historical replay driver.
 *
 * For each past date picked by date-picker.ts, set AULA_REPLAY_DATE and trigger
 * the corresponding daily-notification flow on HA. The Phase-0 getNow() shim
 * makes the prompt-builder think "today" is that past date; MCP fetches real
 * Aula data for the corresponding window; Gemini formats the response; the
 * existing Phase-1 capture writes both trace-*.jsonl and conv-*.jsonl.
 *
 * Designed to be re-run safely — checkpoints completed dates to
 * replay-progress.jsonl. Re-invocation picks up where it left off.
 *
 * Run:
 *   bun run replay.ts --months 6 [--delay 1500] [--kinds weekday,week-end,week-start]
 *
 * Requires .env with:
 *   HAOS_HOST=ws://homeassistant.local:8123/api/websocket
 *   HA_TOKEN=<long-lived access token>
 *   HAOS_TRIGGER_WEEKDAY=script.aula_weekday_morning
 *   HAOS_TRIGGER_WEEK_END=script.aula_week_end
 *   HAOS_TRIGGER_WEEK_START=script.aula_week_start
 */

import { pickDates } from './date-picker';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

interface ReplayArgs {
  months: number;
  delay: number;
  kinds: string[];
}

function parseArgs(): ReplayArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    months: Number(get('--months', '6')),
    delay: Number(get('--delay', '1000')),
    kinds: get('--kinds', 'weekday,week-end,week-start').split(','),
  };
}

const PROGRESS_FILE = 'replay-progress.jsonl';

function loadProgress(): Set<string> {
  if (!existsSync(PROGRESS_FILE)) return new Set();
  return new Set(
    readFileSync(PROGRESS_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).key as string;
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );
}

function markDone(key: string): void {
  appendFileSync(PROGRESS_FILE, JSON.stringify({ key, ts: new Date().toISOString() }) + '\n');
}

interface HAClient {
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * Minimal HA WebSocket client. Implements only what replay needs:
 * connect → auth → call_service → close.
 */
async function connectHA(): Promise<HAClient> {
  const url = process.env.HAOS_HOST;
  const token = process.env.HA_TOKEN;
  if (!url || !token) throw new Error('Set HAOS_HOST and HA_TOKEN in .env');

  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map<number, (msg: any) => void>();

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS error connecting to HA')));
    setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      return;
    }
    if (msg.type === 'result' && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  // Wait for auth_ok.
  await new Promise<void>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === 'auth_ok') {
        ws.removeEventListener('message', handler);
        resolve();
      } else if (msg.type === 'auth_invalid') {
        reject(new Error('HA auth invalid — check HA_TOKEN'));
      }
    };
    ws.addEventListener('message', handler);
  });

  return {
    callService(domain, service, data) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (msg) => (msg.success ? resolve(msg.result) : reject(msg.error)));
        ws.send(
          JSON.stringify({
            id,
            type: 'call_service',
            domain,
            service,
            service_data: data,
          }),
        );
      });
    },
    close() {
      ws.close();
    },
  };
}

function triggerEntity(kind: string): string {
  const key = `HAOS_TRIGGER_${kind.toUpperCase().replace('-', '_')}`;
  const entity = process.env[key];
  if (!entity) throw new Error(`Set ${key} in .env`);
  return entity;
}

async function replayOne(ha: HAClient, kind: string, date: string): Promise<void> {
  const entity = triggerEntity(kind);
  const [domain, service] = entity.split('.');
  // The HA-side script must read replay_date from the call data and propagate
  // it into AULA_REPLAY_DATE for the prompt-builder. See README for the script
  // recipe. Also passes suppress_telegram=true so no message is actually sent.
  await ha.callService(domain, service, {
    replay_date: date,
    suppress_telegram: true,
    kind,
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const done = loadProgress();
  const dates = await pickDates({ months: args.months, kinds: args.kinds });
  const queue = dates.filter((d) => !done.has(`${d.kind}@${d.date}`));

  console.error(
    `[replay] ${queue.length}/${dates.length} pairs to replay (${done.size} already done).`,
  );

  const ha = await connectHA();
  try {
    for (const { kind, date } of queue) {
      const key = `${kind}@${date}`;
      try {
        await replayOne(ha, kind, date);
        markDone(key);
        console.error(`[replay] ok  ${key}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[replay] err ${key}: ${msg}`);
        // Don't mark done — retry on next invocation.
      }
      await new Promise((r) => setTimeout(r, args.delay));
    }
  } finally {
    ha.close();
  }
}

main().catch((err) => {
  console.error('[replay] fatal:', err);
  process.exit(1);
});
