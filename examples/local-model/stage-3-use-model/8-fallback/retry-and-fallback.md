# Retry + fallback wiring

A daily-notification flow that:

1. Tries Ollama via the `aula_local` Assist pipeline.
2. On failure (timeout, validator reject, transport error), retries once with `temperature=0`.
3. On second failure, calls the deterministic emergency template.
4. Always fires the `aula_local_validator_result` event so the E4 canary can update its pass-rate sensor.

## Node-RED layout

```
prompt-builder
   ↓
ollama-attempt-1  ──ok──→ validator ──ok──→ telegram
   ↓ fail or            ↓ fail
   ↓ timeout            ↓
ollama-attempt-2 (t=0) ─ok──→ validator ──ok──→ telegram
   ↓ fail or                  ↓ fail
   ↓ timeout                  ↓
emergency-template ───────────→ telegram (degraded)

Every branch end also fires event 'aula_local_validator_result'
with {ok: bool, attempt: 1|2|"emergency"}.
```

## Function node — `ollama-attempt-N`

Set per-node `attempt` and `temperature`:

```js
const config = flow.get('aula_local_config') || {};
const attempt = 1;        // change per node copy
const temperature = 0.0;  // attempt 1 ⇒ use Modelfile default; attempt 2 ⇒ override to 0

msg.payload = {
    service: 'conversation.process',
    data: {
        agent_id: 'aula_local',
        text: msg.text,
        // HA's Ollama integration accepts conversation-level options:
        // (verify exact field name against your HA version)
        agent_options: { temperature },
    },
};
msg.attempt = attempt;
return msg;
```

Wire timeout via the `delay` node (15 minutes for NUC, 3 minutes for Mac mini) followed by a catch-or-error path.

## Function node — `validator`

```js
const html = msg.payload?.response?.speech?.plain?.speech || msg.payload || '';

// Telegram-HTML balance check on the small whitelist.
const checks = [
    { tag: 'b', balanced: true },
    { tag: 'i', balanced: true },
    { tag: 'blockquote', balanced: true },
];
let ok = true;
for (const c of checks) {
    const o = (html.match(new RegExp(`<${c.tag}>`, 'g')) || []).length;
    const cl = (html.match(new RegExp(`</${c.tag}>`, 'g')) || []).length;
    if (o !== cl) { ok = false; break; }
}
// Must mention at least one expected per-child glyph.
if (!/[👤📚📅📢✉️]/u.test(html)) ok = false;
// Telegram empty-blockquote forbidden.
if (/<blockquote>\s*<\/blockquote>/.test(html)) ok = false;
// Must be at least 100 chars.
if (html.length < 100) ok = false;

msg.validator_ok = ok;
msg.validator_reason = ok ? 'ok' : 'failed_one_of_the_checks';

if (ok) {
    return [msg, null];   // ok branch
} else {
    return [null, msg];   // fail branch
}
```

Node has two outputs: success and failure.

## Function node — `emergency-template`

```js
const { renderEmergency } = global.get('aulaEmergencyTemplate');
// `aulaEmergencyTemplate` is registered in settings.js as a Node-RED
// functionGlobalContext entry pointing at examples/local-model/8-fallback/emergency-template.ts.
// Alternative: pre-compile to JS and require() it from a fixed path.

msg.text = await renderEmergency({
    kind: msg.kind,
    mcpClient: global.get('aulaMcpClient'),
    now: msg.replay_date || undefined,
});
msg.attempt = 'emergency';
return msg;
```

## Event firing — at every terminal branch

```js
// Emits the canary signal regardless of success path.
msg.payload = {
    event_type: 'aula_local_validator_result',
    event_data: {
        ok: msg.attempt !== 'emergency' && msg.validator_ok === true,
        attempt: msg.attempt,
        // Rolling pass rate computed elsewhere (HA template sensor over last 7 days).
        rolling_pass_rate: flow.get('aula_local_rolling_pass_rate') ?? 1.0,
    },
};
return msg;
// Wire into a 'call-service' node calling `event.fire` (or its equivalent
// in your HA version).
```

## Telegram message styling — emergency vs normal

Same telegram-out node. The emergency template includes a footer that makes the degraded state visible to the human reader.

## Test the failure paths before cutover

```bash
# Force Ollama down:
ssh "${INFER_HOST}" "sudo systemctl stop ollama"   # or `brew services stop ollama`

# Trigger the weekday flow from HA → Developer Tools → Services.
# Expect:
#   - ollama-attempt-1 errors (after timeout or HTTP error)
#   - ollama-attempt-2 errors similarly
#   - emergency-template runs, fetches MCP, sends a degraded message
#   - aula_local_validator_result event fires with ok: false, attempt: "emergency"

# Bring Ollama back:
ssh "${INFER_HOST}" "sudo systemctl start ollama"
```

## Why retry only once

A 3B model that failed deterministically isn't going to succeed on the 3rd attempt at higher temperature. Multiple retries delay the emergency message without improving outcomes. One retry at `temp=0` catches transient nondeterminism (rare with `temp=0` but possible across the tool-call loop); after that, fail cleanly.
