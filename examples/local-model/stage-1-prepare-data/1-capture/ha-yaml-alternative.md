# Path B — HA YAML capture (no Node-RED)

If you run the three prompts purely through HA scripts/automations rather than Node-RED, you can capture via a single automation that listens for the `conversation_finished` event.

## Caveat

`conversation_finished` fires for HA Assist (UI) calls. It is **not guaranteed** to fire when the conversation is invoked via the `conversation.process` service from a script. If your daily runs use the service-call path and you find no events arrive, fall back to capturing inside the script itself with `service: shell_command.log_aula_conv` immediately after the conversation call.

## `configuration.yaml`

```yaml
shell_command:
  log_aula_conv: >
    bash -c "echo '{{ payload | to_json | replace(\"'\", \"'\\\\''\") }}' >> /config/aula-train/conv-$(date +%F).jsonl"

automation:
  - alias: aula_log_conversation
    trigger:
      platform: event
      event_type: conversation_finished
    condition:
      # Only log conversations that went through our pipeline.
      # Adjust the heuristic to whatever uniquely identifies your daily runs:
      # an agent id, a specific input phrase, etc.
      - condition: template
        value_template: >
          {{ trigger.event.data.agent_id == 'aula_local' or
             'aula' in (trigger.event.data.result.response.speech.plain.speech | default('') | lower) }}
    action:
      service: shell_command.log_aula_conv
      data:
        payload:
          ts: "{{ now().isoformat() }}"
          kind: "{{ 'unknown' }}"  # set this from a script-level variable if possible
          conv_id: "{{ trigger.event.data.conversation_id }}"
          prompt: "{{ trigger.event.data.text | default('') }}"
          response: "{{ trigger.event.data.result.response.speech.plain.speech | default('') }}"
```

## Script-call alternative (more reliable for `conversation.process` callers)

In your existing daily-notification script, immediately after the conversation call:

```yaml
script:
  aula_weekday_morning:
    sequence:
      - service: conversation.process
        data:
          agent_id: !secret gemini_agent_id
          text: "{{ states('input_text.aula_prompt_weekday') }}"
        response_variable: conv_result
      - service: shell_command.log_aula_conv
        data:
          payload:
            ts: "{{ now().isoformat() }}"
            kind: weekday
            conv_id: "{{ conv_result.conversation_id | default('script-' ~ now().timestamp() | int) }}"
            prompt: "{{ states('input_text.aula_prompt_weekday') }}"
            response: "{{ conv_result.response.speech.plain.speech | default('') }}"
      - service: notify.telegram_xxx
        data:
          message: "{{ conv_result.response.speech.plain.speech }}"
```

This guarantees the capture line, independent of whether HA fires `conversation_finished`.

## Disk path + rotation

Same as Path A: writes to `/config/aula-train/conv-YYYY-MM-DD.jsonl`. The 90-day rotation in `0-bootstrap/verify-haos-paths.md` cleans both `trace-*.jsonl` and `conv-*.jsonl`.

## Verification

After one daily run completes:

```bash
ls -la /config/aula-train/conv-*.jsonl       # expect at least 1 file
tail -1 /config/aula-train/conv-$(date +%F).jsonl | jq .
```

If `jq` reports a parse error, the `shell_command` echo escape isn't quite right for your shell — replace with a slightly more robust:

```yaml
shell_command:
  log_aula_conv: >
    python3 -c "import json,sys,datetime; open(f'/config/aula-train/conv-{datetime.date.today()}.jsonl','a').write(json.dumps(json.loads(sys.argv[1]))+'\n')" '{{ payload | to_json }}'
```
