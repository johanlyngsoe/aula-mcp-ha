/**
 * Join Node-RED conversation captures with MCP tool-call traces into
 * training-ready (prompt, tool_calls[], response) pairs.
 *
 * Reads:
 *   <in>/conv-YYYY-MM-DD.jsonl    — one record per daily run (Phase 1)
 *   <in>/trace-YYYY-MM-DD.jsonl   — many records per daily run (Phase 0 tracer)
 *
 * Writes:
 *   <out>                          — one JSON record per training pair
 *
 * Joining strategy:
 *   1. Group trace records by `sessionId`. Each group is one "session".
 *   2. For each conv record, find the trace session where:
 *        sessionId == conv.conv_id  (exact match preferred)
 *        OR session time range overlaps conv.ts ± 10 minutes (fallback).
 *   3. Output `{prompt, response, kind, conv_id, ts, tool_calls: [{tool, args, result, duration_ms, ok}, ...]}`.
 *
 * Run:
 *   bun run join-with-trace.ts --in ~/aula-train/raw --out ~/aula-train/raw/pairs.jsonl
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

interface ConvRecord {
  ts: string;
  kind: string;
  conv_id: string;
  prompt: string;
  response: string;
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

interface Pair {
  conv_id: string;
  kind: string;
  ts: string;
  prompt: string;
  response: string;
  tool_calls: Array<Omit<TraceRecord, 'sessionId'>>;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function listFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

function groupBySession(traces: TraceRecord[]): Map<string, TraceRecord[]> {
  const map = new Map<string, TraceRecord[]>();
  for (const t of traces) {
    if (!map.has(t.sessionId)) map.set(t.sessionId, []);
    map.get(t.sessionId)!.push(t);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return map;
}

function sessionTimeRange(records: TraceRecord[]): [number, number] {
  const ts = records.map((r) => Date.parse(r.ts));
  return [Math.min(...ts), Math.max(...ts)];
}

function pickSessionForConv(
  conv: ConvRecord,
  bySession: Map<string, TraceRecord[]>,
  usedSessions: Set<string>,
): TraceRecord[] | null {
  // Exact match first.
  if (bySession.has(conv.conv_id) && !usedSessions.has(conv.conv_id)) {
    usedSessions.add(conv.conv_id);
    return bySession.get(conv.conv_id)!;
  }
  // Fallback: time-window overlap.
  const convT = Date.parse(conv.ts);
  let best: { session: string; dist: number } | null = null;
  for (const [sid, records] of bySession) {
    if (usedSessions.has(sid)) continue;
    const [s, e] = sessionTimeRange(records);
    // Session must straddle or be within 10 min of the conv.
    const dist = Math.max(0, Math.max(s - convT, convT - e));
    if (dist <= 10 * 60_000) {
      if (!best || dist < best.dist) best = { session: sid, dist };
    }
  }
  if (best) {
    usedSessions.add(best.session);
    return bySession.get(best.session)!;
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const inDir = get('--in', `${process.env.HOME}/aula-train/raw`);
  const outFile = get('--out', `${process.env.HOME}/aula-train/raw/pairs.jsonl`);

  const convs = listFiles(inDir, 'conv-').flatMap((f) => readJsonl<ConvRecord>(f));
  const traces = listFiles(inDir, 'trace-').flatMap((f) => readJsonl<TraceRecord>(f));

  console.error(`[join] convs=${convs.length} traces=${traces.length}`);

  const bySession = groupBySession(traces);
  const used = new Set<string>();
  const pairs: Pair[] = [];
  let unmatched = 0;

  // Process conversations newest-first so reused sessionId values prefer recent matches.
  convs.sort((a, b) => b.ts.localeCompare(a.ts));

  for (const conv of convs) {
    const records = pickSessionForConv(conv, bySession, used);
    if (!records) {
      unmatched++;
      continue;
    }
    pairs.push({
      conv_id: conv.conv_id,
      kind: conv.kind,
      ts: conv.ts,
      prompt: conv.prompt,
      response: conv.response,
      tool_calls: records.map((r) => ({
        ts: r.ts,
        tool: r.tool,
        args: r.args,
        result: r.result,
        duration_ms: r.duration_ms,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      })),
    });
  }

  writeFileSync(outFile, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
  console.error(`[join] pairs=${pairs.length} unmatched_convs=${unmatched} → ${outFile}`);
}

main();
