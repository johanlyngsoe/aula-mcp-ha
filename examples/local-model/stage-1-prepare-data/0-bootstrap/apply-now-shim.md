# Patch: `getNow()` shim in the three prompt files

## Why

Phase 2 (historical replay) needs to compute the prompt as if "today were a past date." The prompt files call `new Date()` directly, which always returns wall-clock time. The shim makes "now" a function that respects `AULA_REPLAY_DATE`, defaulting to wall-clock when the env var is absent.

## Files affected

- `examples/daily-overview-prompts/prompt-weekday.js`
- `examples/daily-overview-prompts/prompt-week-end.js`
- `examples/daily-overview-prompts/prompt-week-start.js`

## Patch (all three files — same pattern)

Before:
```js
const COPENHAGEN = 'Europe/Copenhagen';

const today = new Date();
const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
```

After:
```js
const COPENHAGEN = 'Europe/Copenhagen';

// Replay shim: when AULA_REPLAY_DATE is set (ISO 8601), treat that as "now".
// Otherwise use wall clock — production behaviour unchanged.
const getNow = () => {
  const override = (typeof process !== 'undefined' && process.env && process.env.AULA_REPLAY_DATE) || null;
  return override ? new Date(override) : new Date();
};

const today = getNow();
const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
```

Also add this single line to the DATA section (after the existing `aula.posts.list` line) **in all three files**:

```
- Send ALTID compact: true til aula.posts.list, aula.messages.list_threads, aula.messages.get_thread og aula.ugeplan.*.
```

This trains the model (via the historical replay) to always pass `compact=true`.

## Why this is safe in Node-RED function nodes

Node-RED function nodes expose `process.env` by default. If your HA setup runs the prompts in a stricter sandbox where `process` is undefined, the `typeof process !== 'undefined'` guard makes the shim degrade gracefully back to wall-clock. No crash.

## Verification

```bash
# 1. Production behaviour unchanged (no env var)
node -e "$(cat examples/daily-overview-prompts/prompt-weekday.js)" | head -5
# Expect: today's date in the KONTEKST section

# 2. Replay override works
AULA_REPLAY_DATE=2025-09-15T08:00:00 \
  node -e "$(cat examples/daily-overview-prompts/prompt-weekday.js)" | head -5
# Expect: 'I DAG er mandag 15. september 2025'
```

## Rollback

Revert the diff. No data migration required.
