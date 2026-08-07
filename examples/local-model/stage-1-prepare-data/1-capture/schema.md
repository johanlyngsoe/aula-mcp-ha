# JSONL schema

Two parallel JSONL streams. Each line is one self-contained JSON record.

## `conv-YYYY-MM-DD.jsonl` — conversation log (Node-RED / HA)

```json
{
  "ts": "2026-06-17T07:30:14.213Z",
  "kind": "weekday",
  "conv_id": "0193b8f3-...-aula",
  "prompt": "Analysér data fra Aula og giv et dagligt overblik formateret som HTML til Telegram.\n\nKONTEKST:\n- I DAG er onsdag 17. juni 2026 ...",
  "response": "📅 <b>DAGLIGT OVERBLIK — i morgen</b>\n<i>torsdag 18. juni 2026</i>\n\n👤 <b>Anna</b>\n📅 ..."
}
```

| Field | Type | Notes |
|---|---|---|
| `ts` | string (ISO 8601) | Wall-clock time the record was written. Used to join to MCP traces. |
| `kind` | `"weekday" \| "week-end" \| "week-start"` | Which prompt template ran. |
| `conv_id` | string | HA conversation_id when available; otherwise a synthesised `ts-…` value. Used to join to MCP traces via `sessionId` (or as a tiebreaker when `sessionId` correlation is ambiguous). |
| `prompt` | string | The full assembled Danish prompt — output of `prompt-weekday.js` etc. |
| `response` | string | The final Telegram-HTML string returned by the conversation agent. |

## `trace-YYYY-MM-DD.jsonl` — MCP tool-call log (`aula-mcp`)

```json
{
  "ts": "2026-06-17T07:30:14.612Z",
  "sessionId": "0193b8f3-...-aula",
  "tool": "aula.discover",
  "args": {},
  "result": {
    "children": [{"id": 12345, "name": "Anna", "institution": {"code": "G12345"}}, ...],
    "detectedWidgets": ["easyiq", "minuddannelse"],
    "usage": {...}
  },
  "duration_ms": 143,
  "ok": true
}
```

| Field | Type | Notes |
|---|---|---|
| `ts` | string (ISO 8601) | When the tool call returned. |
| `sessionId` | string | Per-SSE-session ID assigned by `aula-mcp` (or `stdio-<pid>` for stdio transport). Used to group all tool calls of one daily run. |
| `tool` | string | Fully-qualified MCP tool name, e.g. `aula.posts.list`. |
| `args` | unknown | Whatever the model passed as args, JSON-serialised. |
| `result` | unknown | Whatever the tool returned, JSON-serialised. Omitted when `ok=false`. |
| `duration_ms` | number | Wall-clock duration of the tool handler. |
| `ok` | boolean | True when handler returned without throwing. |
| `error` | string (optional) | Error message when `ok=false`. |

## Joining the streams (Phase 2 `join-with-trace.ts`)

A single daily run produces:

- 1 line in `conv-…jsonl` (the final notification).
- N lines in `trace-…jsonl` (one per tool call), all sharing the same `sessionId`.

The joiner groups trace records by `sessionId`, builds a tool-call sequence per session, then pairs each session with the closest `conv-*` record by `ts` (within a ±10-minute window). When `conv_id == sessionId` (the common case after the Node-RED flow is wired correctly), the join is exact.

## Why two files instead of one

- The MCP server doesn't know about the conversation as a whole — it only sees individual tool requests.
- Node-RED doesn't see the intermediate tool calls — only the final response.
- Both writers are append-only, single-file-per-day. Joining is a Mac-side concern (Phase 2) so neither writer needs to coordinate.

## Notes for replay (Phase 2)

The replay harness reuses the same writers — it forces `AULA_REPLAY_DATE`, runs the conversation, and the traces + conv records land in the same dirs (just back-dated). Phase 2 adds a `replay` boolean to discriminate replayed records from natural ones if you ever need to weight them differently.
