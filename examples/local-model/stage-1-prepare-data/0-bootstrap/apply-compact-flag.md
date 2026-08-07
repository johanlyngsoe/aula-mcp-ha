# Patch: `compact=true` flag on verbose MCP tools

## Why

Three tool families return HTML-bodied content that balloons context: `aula.posts.list` (HTML post bodies), `aula.messages.list_threads` and `aula.messages.get_thread` (HTML message text), and the seven `aula.ugeplan.*` tools (free-form `content` strings). At full verbosity, a busy week trace can exceed 50 K tokens — over Qwen2.5-3B's 32 K context.

`compact=true` returns the same semantic content stripped of HTML, with bodies truncated to ~500 chars and internal `_groupId` / `_institutionCode` etc. dropped. Cuts ~60 % of tokens.

Default behaviour (`compact` unset or `false`) is preserved exactly — this is opt-in.

## Files affected

- `packages/mcp-server/src/tools.ts` — adds the flag to the input schemas and a small compaction helper.
- `packages/aula-client/src/integrations/types.ts` — already exports `NormalisedWeekPlanItem`; no change needed.

## Helper to add at the top of `tools.ts` (after the existing `jsonContent`)

```ts
/**
 * Strip HTML to plain text, collapse whitespace, truncate.
 * Conservative — for full fidelity, omit `compact: true`.
 */
function compactText(input: string | null | undefined, max = 500): string {
  if (!input) return '';
  const plain = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain.length > max ? plain.slice(0, max).trimEnd() + '…' : plain;
}

/**
 * Drop bulky internal-only fields added by aula-mcp during fan-out.
 * Keep what the model needs to route + format.
 */
function stripInternals<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const { _groupId, _institutionCode, _institutionName, _groupName, ...rest } = obj as Record<
    string,
    unknown
  >;
  return rest as Partial<T>;
}
```

## Patch: `aula.posts.list` (around line 134)

In the `inputSchema` object, add:

```ts
        compact: z
          .boolean()
          .optional()
          .describe(
            'When true, strip HTML bodies, truncate to ~500 chars, and drop internal _groupId/_institutionCode fields. Significantly reduces token count for small LLMs.',
          ),
```

In the handler, after fetching `posts` and before `jsonContent`:

```ts
      if (args.compact) {
        const compacted = posts.map((p: any) => ({
          ...stripInternals(p),
          content: p.content
            ? { ...p.content, html: undefined, body: compactText(p.content.html ?? p.content.body) }
            : p.content,
        }));
        return jsonContent({ posts: compacted });
      }
```

(Adapt the field names to the actual shape returned by the existing handler — the `_groupId` etc. additions live in `aula-client/src/integrations`; the post body field is `content.html` in the current code.)

## Patch: `aula.messages.list_threads` (around line 297)

Add the same `compact: z.boolean().optional()` schema entry.

In the handler, after fetching threads:

```ts
      if (args.compact) {
        const compacted = threads.map((t: any) => ({
          ...t,
          lastMessage: t.lastMessage
            ? {
                ...t.lastMessage,
                text: t.lastMessage.text
                  ? {
                      plain: compactText(t.lastMessage.text.plain ?? t.lastMessage.text.html, 300),
                    }
                  : undefined,
              }
            : undefined,
        }));
        return jsonContent({ threads: compacted });
      }
```

## Patch: `aula.messages.get_thread` (around line 496)

Add `compact: z.boolean().optional()`.

In the handler, after fetching the thread:

```ts
      if (args.compact && 'messages' in result) {
        const compacted = {
          ...result,
          messages: result.messages.map((m: any) => ({
            sender: m.sender,
            subject: m.subject,
            sendDateTime: m.sendDateTime,
            text: { plain: compactText(m.text?.plain ?? m.text?.html, 800) },
          })),
        };
        return jsonContent(compacted);
      }
```

## Patch: each of the seven `aula.ugeplan.*` tools (lines 379, 392, 405, 421, 437, 450, 463)

All seven use the same `NormalisedWeekPlan` return shape. Add `compact: z.boolean().optional()` to each input schema. Add this shared compaction in each handler before `jsonContent`:

```ts
      if (args.compact) {
        return jsonContent({
          ...plan,
          items: plan.items.map((item: any) => ({
            childName: item.childName,
            date: item.date,
            subject: item.subject,
            title: item.title,
            content: compactText(item.content, 300),
            kind: item.kind,
            url: item.url,
          })),
          raw: undefined, // raw is verbose; not needed when compact
        });
      }
```

## Unit test sketch

Add to `packages/mcp-server/src/server.test.ts`:

```ts
test('aula.posts.list returns plain text + truncated bodies when compact=true', async () => {
  // arrange: mock posts with HTML body > 500 chars
  // act: call tool with compact: true
  // assert: response.content[0].text parsed → posts[0].content.body has no '<' or '>'
  //         and length <= 503 (with '…' suffix)
});
```

## Verification

```bash
# Run the existing test suite — nothing should regress.
bun test

# Manual smoke test: hit the tool both ways and diff sizes.
# (Substitute your own MCP client invocation here.)
```

## Rollback

`git revert <commit>`. Safe at any time; clients that already pass `compact: true` would simply get verbose output again.

## Why these defaults

- 500-char post bodies: enough for the model to detect action-required posts; longer bodies are almost always boilerplate (sign-off, weekly recap framing, etc.).
- 300-char message previews: enough for cancellation / substitute teacher / change-of-time signal.
- 800-char `get_thread`: when the model decides to fetch a single thread in full it usually does so because the preview wasn't enough; give it more room there.
- 300-char ugeplan `content`: descriptions are typically 1-3 sentences; longer items are rare and informational.

If you observe E1 failures from over-truncation, bump these in `compactText(..., max)` and retrain.
