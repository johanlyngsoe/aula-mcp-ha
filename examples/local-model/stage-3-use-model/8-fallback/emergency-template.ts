/**
 * Deterministic emergency notification template.
 *
 * No LLM involvement. Fetches raw MCP data and formats a minimum-viable
 * Telegram-HTML message. The model's downstream prettiness is replaced by
 * reliability — every section gets a strip-and-list rendering.
 *
 * Invoked from Node-RED when both Ollama attempts fail. Returns the HTML
 * string for the telegram-out node.
 *
 * Usage (Node-RED function node):
 *   const { renderEmergency } = require('./emergency-template');
 *   msg.payload = await renderEmergency({ kind: msg.kind, mcpClient: msg.mcp });
 *   return msg;
 */

export interface RenderArgs {
  kind: 'weekday' | 'week-end' | 'week-start';
  /** Anything that exposes `.callTool(name, args)` returning the MCP result. */
  mcpClient: {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  /** ISO 8601 override; defaults to wall-clock. */
  now?: string;
}

export async function renderEmergency(args: RenderArgs): Promise<string> {
  const now = args.now ? new Date(args.now) : new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const fmtDanish = (d: Date) =>
    new Intl.DateTimeFormat('da-DK', {
      timeZone: 'Europe/Copenhagen',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);

  const lines: string[] = [];
  lines.push('🚨 <b>Notifikation kunne ikke genereres normalt</b>');
  lines.push(`<i>${escape(fmtDanish(now))}</i>`);
  lines.push('');

  // Discover children.
  const manifest = (await args.mcpClient.callTool('aula.discover', {})) as DiscoverManifest;
  const children = manifest?.children ?? [];

  if (children.length === 0) {
    lines.push('Ingen børn fundet i Aula-manifestet. Tjek auth.');
    return lines.join('\n');
  }

  for (const child of children) {
    lines.push(`👤 <b>${escape(child.name)}</b>`);

    // Calendar for tomorrow (weekday/week-start) or week (week-end).
    try {
      const range = args.kind === 'week-end' ? 'next_week' : 'tomorrow';
      const events = (await args.mcpClient.callTool('aula.calendar.events', {
        profileIds: [child.institution.id],
        range,
      })) as CalendarEvent[];
      if (events && events.length > 0) {
        lines.push(`📅 <b>${range === 'next_week' ? 'Næste uge' : 'I morgen'}</b>:`);
        for (const e of events.slice(0, 12)) {
          const hhmm = e.startDateTime?.slice(11, 16) ?? '';
          lines.push(`- ${escape(hhmm)} ${escape(e.title)}`);
        }
      }
    } catch (err) {
      lines.push(`📅 (kalender utilgængelig: ${escape(String(err))})`);
    }

    // Posts (recent, compact).
    try {
      const postsResp = (await args.mcpClient.callTool('aula.posts.list', {
        limit: 10,
        compact: true,
      })) as { posts: PostSummary[] };
      const childPosts = (postsResp?.posts ?? []).filter((p) =>
        p._institutionCode === child.institution.code,
      );
      if (childPosts.length > 0) {
        lines.push(`📢 Nye opslag (${childPosts.length}):`);
        for (const p of childPosts.slice(0, 5)) {
          const stamp = p.publishedAt?.slice(0, 16).replace('T', ' ') ?? '';
          const title = p.title ?? p.content?.body?.slice(0, 60) ?? '(uden titel)';
          lines.push(`- ${escape(stamp)} — ${escape(title)}`);
        }
      }
    } catch (err) {
      lines.push(`📢 (opslag utilgængelige: ${escape(String(err))})`);
    }

    // Messages.
    try {
      const threadsResp = (await args.mcpClient.callTool('aula.messages.list_threads', {
        pageSize: 10,
        compact: true,
      })) as { threads: ThreadSummary[] };
      const childThreads = (threadsResp?.threads ?? []).filter((t) => !t.read);
      if (childThreads.length > 0) {
        lines.push(`✉️ Beskeder (${childThreads.length}):`);
        for (const t of childThreads.slice(0, 4)) {
          const stamp = t.lastMessage?.sendDateTime?.slice(0, 16).replace('T', ' ') ?? '';
          const subject = t.subject ?? '(uden emne)';
          const sender = t.lastMessage?.sender?.fullName ?? 'ukendt';
          lines.push(`- ${escape(sender)}, ${escape(stamp)} — ${escape(subject)}`);
        }
      }
    } catch (err) {
      lines.push(`✉️ (beskeder utilgængelige: ${escape(String(err))})`);
    }

    lines.push('');
  }

  lines.push('<i>Hvis du ser denne besked betyder det at den lokale model fejlede. Tjek logs.</i>');
  return lines.join('\n');
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- types (loose; the real shapes live in packages/aula-client/src/aula-types.ts) ---

interface DiscoverManifest {
  children: Array<{
    id: number;
    name: string;
    institution: { id: number; code: string };
  }>;
}

interface CalendarEvent {
  title: string;
  startDateTime?: string;
  endDateTime?: string;
}

interface PostSummary {
  publishedAt?: string;
  title?: string;
  content?: { body?: string };
  _institutionCode?: string;
}

interface ThreadSummary {
  read: boolean;
  subject?: string;
  lastMessage?: {
    sendDateTime?: string;
    sender?: { fullName?: string };
  };
}
