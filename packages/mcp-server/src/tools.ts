/**
 * MCP tool registrations. Each tool delegates to AulaContext / AulaClient.
 * Inputs are validated by Zod 4 schemas registered with McpServer.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

import { AulaStepUpRequiredError, isoWeekString } from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import mammoth from 'mammoth';
import { z } from 'zod';
import type { AulaContext } from './aula-context.ts';
import {
  addDays,
  aulaTs,
  resolveCalendarRange,
  startOfDayCopenhagen,
} from './calendar-range.ts';
import { buildDiscoverManifest } from './discover.ts';

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const execFileAsync = promisify(execFile);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 30_000;

function normalizeAttachmentText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateAttachmentText(value: string): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= MAX_ATTACHMENT_TEXT_CHARS) {
    return { text: value, truncated: false };
  }

  return {
    text: value.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
    truncated: true,
  };
}

type ParsedAttachment = {
  format?: 'pdf' | 'docx' | 'txt';
  text?: string;
  truncated?: boolean;
  ocrRequired?: boolean;
  readError?: string;
};

async function parseAttachmentFile(
  name: string,
  url: string,
): Promise<ParsedAttachment> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return {
        readError: `Attachment download failed with HTTP ${response.status}`,
      };
    }

    const declaredLength = Number(
      response.headers.get('content-length') ?? 0,
    );

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_ATTACHMENT_BYTES
    ) {
      return {
        readError: `Attachment exceeds maximum supported size (${MAX_ATTACHMENT_BYTES} bytes)`,
      };
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return {
        readError: `Attachment exceeds maximum supported size (${MAX_ATTACHMENT_BYTES} bytes)`,
      };
    }

    const extension = extname(name).toLowerCase();
    let extractedText = '';
    let format: 'pdf' | 'docx' | 'txt';

    if (extension === '.pdf') {
      format = 'pdf';

      const workDir = await mkdtemp(
        join(tmpdir(), 'aula-attachment-'),
      );
      const inputFile = join(workDir, 'input.pdf');
      const outputFile = join(workDir, 'output.txt');

      try {
        await writeFile(inputFile, bytes);

        await execFileAsync(
          'pdftotext',
          ['-layout', '-enc', 'UTF-8', inputFile, outputFile],
          {
            maxBuffer: 2 * 1024 * 1024,
          },
        );

        extractedText = await readFile(outputFile, 'utf8');
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    } else if (extension === '.docx') {
      format = 'docx';

      const result = await mammoth.extractRawText({
        buffer: bytes,
      });

      extractedText = result.value;
    } else if (extension === '.txt') {
      format = 'txt';
      extractedText = bytes.toString('utf8');
    } else {
      return {
        readError: 'Unsupported attachment type',
      };
    }

    const normalizedText = normalizeAttachmentText(extractedText);

    if (format === 'pdf' && normalizedText.length < 20) {
      return {
        format,
        text: normalizedText,
        truncated: false,
        ocrRequired: true,
      };
    }

    const output = truncateAttachmentText(normalizedText);

    return {
      format,
      text: output.text,
      truncated: output.truncated,
      ocrRequired: false,
    };
  } catch (error) {
    return {
      readError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function htmlToText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;

  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

type ResolvedRelativeDate = {
  resolvedDate: string;
  resolvedFrom: string;
};

function formatCopenhagenDate(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = fmt.formatToParts(d);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function resolveRelativePostDate(
  post: Record<string, unknown>,
): ResolvedRelativeDate | undefined {
  const publishedAt =
    typeof post.publishedAt === 'string'
      ? post.publishedAt
      : undefined;

  if (!publishedAt) return undefined;

  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return undefined;

  const title =
    typeof post.title === 'string'
      ? post.title
      : '';

  const body =
    typeof post.text === 'string'
      ? post.text
      : '';

  const source = `${title}\n${body}`;

  // "i morgen" = exactly one calendar day after publication.
  const tomorrowMatch = source.match(/\bi morgen\b/i);

  if (tomorrowMatch) {
    const base = startOfDayCopenhagen(published);
    const resolved = addDays(base, 1);

    return {
      resolvedDate: formatCopenhagenDate(resolved),
      resolvedFrom: tomorrowMatch[0],
    };
  }

  // "på mandag", "på tirsdag", etc. means the first matching
  // weekday strictly AFTER the publication date.
  const weekdayMatch = source.match(
    /\bpå\s+(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b/i,
  );

  if (!weekdayMatch) return undefined;

  const weekdayMap: Record<string, number> = {
    søndag: 0,
    mandag: 1,
    tirsdag: 2,
    onsdag: 3,
    torsdag: 4,
    fredag: 5,
    lørdag: 6,
  };

  const requestedDay =
    weekdayMap[weekdayMatch[1].toLowerCase()];

  if (requestedDay === undefined) return undefined;

  const base = startOfDayCopenhagen(published);

  // Determine weekday from the Copenhagen calendar date.
  // Date.UTC avoids the host/container timezone influencing getUTCDay().
  const copenhagenDate = formatCopenhagenDate(base);
  const [year, month, day] = copenhagenDate
    .split('-')
    .map(Number);

  const publishedDay = new Date(
    Date.UTC(year, month - 1, day),
  ).getUTCDay();

  let daysAhead = (requestedDay - publishedDay + 7) % 7;

  // "på tirsdag" on a Tuesday means next Tuesday, not today.
  if (daysAhead === 0) {
    daysAhead = 7;
  }

  const resolved = addDays(base, daysAhead);

  return {
    resolvedDate: formatCopenhagenDate(resolved),
    resolvedFrom: weekdayMatch[0],
  };
}

function compactPost(post: Record<string, unknown>): Record<string, unknown> {
  const content = post.content as { html?: unknown } | undefined;

  const relatedProfiles = Array.isArray(post.relatedProfiles)
    ? post.relatedProfiles
    : [];

  const children = relatedProfiles
    .map((profile) => {
      if (!profile || typeof profile !== 'object') return undefined;
      const p = profile as Record<string, unknown>;
      return typeof p.fullName === 'string' ? p.fullName : undefined;
    })
    .filter((name): name is string => Boolean(name));

  const sharedWithGroups = Array.isArray(post.sharedWithGroups)
    ? post.sharedWithGroups
    : [];

  const groups = sharedWithGroups
    .map((group) => {
      if (!group || typeof group !== 'object') return undefined;
      const g = group as Record<string, unknown>;
      return typeof g.name === 'string' ? g.name : undefined;
    })
    .filter((name): name is string => Boolean(name));

  const attachmentsRaw = Array.isArray(post.attachments)
    ? post.attachments
    : [];

  const attachments = attachmentsRaw
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return undefined;
      const a = attachment as Record<string, unknown>;

      const id =
        typeof a.id === 'number'
          ? a.id
          : a.file && typeof a.file === 'object'
            ? (a.file as Record<string, unknown>).id
            : undefined;

      const name =
        typeof a.name === 'string'
          ? a.name
          : a.file && typeof a.file === 'object'
            ? (a.file as Record<string, unknown>).name
            : undefined;

      if (typeof id !== 'number' || typeof name !== 'string') {
        return undefined;
      }

      const postIdRaw = post.id ?? post.postId;
      const postId =
        typeof postIdRaw === 'number'
          ? postIdRaw
          : Number(postIdRaw);

      if (!Number.isFinite(postId)) {
        return { id, name };
      }

      const extension = extname(name).toLowerCase();
      const readable = ['.pdf', '.docx', '.txt'].includes(extension);

      return {
        id,
        name,
        readable,
        ...(readable
          ? {
              readWith: {
                tool: 'aula_attachment_read',
                postId,
                attachmentId: id,
              },
            }
          : {}),
      };
    })
    .filter((attachment) => Boolean(attachment));

  const text =
    htmlToText(content?.html) ??
    (typeof post.text === 'string' ? post.text : undefined);

  return {
    id: post.id ?? post.postId,
    ...(typeof post.title === 'string' ? { title: post.title } : {}),
    ...(text ? { text } : {}),
    ...(typeof post.publishAt === 'string'
      ? { publishedAt: toCopenhagenIso(post.publishAt) }
      : typeof post.timestamp === 'string'
        ? { publishedAt: toCopenhagenIso(post.timestamp) }
        : {}),
    ...(typeof post.isImportant === 'boolean'
      ? { important: post.isImportant }
      : {}),
    ...(typeof post.importantTo === 'string'
      ? { importantUntil: toCopenhagenIso(post.importantTo) }
      : {}),
    ...(children.length > 0 ? { children } : {}),
    ...(groups.length > 0 ? { groups } : {}),
    ...(typeof post._groupName === 'string'
      ? { sourceGroup: post._groupName }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof post.commentCount === 'number'
      ? { commentCount: post.commentCount }
      : {}),
  };
}

function compactPostsResponse(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.posts)) return data;

  return {
    ...obj,
    posts: obj.posts.map((post) =>
      post && typeof post === 'object'
        ? compactPost(post as Record<string, unknown>)
        : post,
    ),
  };
}

function toCopenhagenIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';

  return get('year') + '-' + get('month') + '-' + get('day') +
    'T' + get('hour') + ':' + get('minute') + ':' + get('second') + offset;
}

function compactNotifications(data: unknown): unknown {
  if (!Array.isArray(data)) return data;

  const groupedMedia = new Map<number, {
    type: string;
    albumId: number;
    count: number;
    triggered?: string;
  }>();

  const result: Array<Record<string, unknown>> = [];

  for (const item of data) {
    if (!item || typeof item !== 'object') continue;

    const n = item as Record<string, unknown>;
    const type = typeof n.notificationEventType === 'string'
      ? n.notificationEventType
      : 'Unknown';

    const triggered = typeof n.triggered === 'string'
      ? toCopenhagenIso(n.triggered)
      : undefined;

    if ((type === 'NewMedia' || type === 'MediaAddedToAlbum') &&
        typeof n.albumId === 'number') {
      const existing = groupedMedia.get(n.albumId);

      if (existing) {
        existing.count += 1;
        if (!existing.triggered && triggered) existing.triggered = triggered;
      } else {
        groupedMedia.set(n.albumId, {
          type: 'AlbumActivity',
          albumId: n.albumId,
          count: 1,
          ...(triggered ? { triggered } : {}),
        });
      }

      continue;
    }

    result.push({
      type,
      ...(typeof n.postTitle === 'string' ? { title: n.postTitle } : {}),
      ...(typeof n.postId === 'number' ? { postId: n.postId } : {}),
      ...(typeof n.albumName === 'string' ? { albumName: n.albumName } : {}),
      ...(typeof n.albumId === 'number' ? { albumId: n.albumId } : {}),
      ...(typeof n.relatedChildName === 'string'
        ? { child: n.relatedChildName }
        : {}),
      ...(triggered ? { triggered } : {}),
    });
  }

  return [
    ...result,
    ...Array.from(groupedMedia.values()),
  ];
}

export function registerTools(server: McpServer, context: AulaContext): void {
  // --- aula_discover -------------------------------------------------------

  server.registerTool(
    'aula_discover',
    {
      title: 'Discover Aula context',
      description:
        'Returns a typed manifest of the logged-in guardian: children (with names + ids), ' +
        'institutions, API version, detected widgets, and which subordinate aula.* tools to ' +
        'call. Includes a `usage` block with name-resolution and tool-selection rules. ' +
        'Call ONCE per session and reuse the result — do not re-call mid-session.',
      inputSchema: {},
    },
    async () => {
      const manifest = await buildDiscoverManifest(context);
      return jsonContent(manifest);
    },
  );

  // --- aula_profiles_list --------------------------------------------------

  server.registerTool(
    'aula_profiles_list',
    {
      title: 'List Aula profiles',
      description: 'Raw profiles.getProfilesByLogin response — every child + institution.',
      inputSchema: {},
    },
    async () => {
      const client = await context.getClient();
      return jsonContent(await client.getProfilesByLogin());
    },
  );

  // --- aula_presence_today -------------------------------------------------

  server.registerTool(
    'aula_presence_today',
    {
      title: 'Daily presence overview',
      description:
        'Returns presence/check-in/check-out info for the given child IDs. Status codes: ' +
        '0=IKKE_KOMMET, 1=KOMMET, 2=PAA_TUR, 3=SOVER, 4=HENTET, 5=FRI, 6=FERIE, 7=SYG, ' +
        '8=KOMMET_SELV.',
      inputSchema: {
        childIds: z
          .array(z.number().int().min(1))
          .min(1)
          .describe('Aula child IDs (from aula_discover.children[].id)'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      return jsonContent(await client.getDailyOverview(args.childIds));
    },
  );

  // --- aula_calendar_events ------------------------------------------------

  server.registerTool(
    'aula_calendar_events',
    {
      title: 'Calendar events (school schedule)',
      description:
        'Lessons + events for the given institution-profile IDs. ' +
        'Get profileIds from aula_discover → children[].institution.id (NOT children[].id or children[].userId). ' +
        'Pass `range` for a preset window (today/tomorrow/this_week/next_week) ' +
        'OR `start`+`end` for a specific window. Timestamps are formatted as Aula ' +
        'expects: "YYYY-MM-DD HH:MM:SS.0000+ZZZZ". Aula uses Europe/Copenhagen.',
      inputSchema: {
        profileIds: z.array(z.number().int().min(1)).min(1),
        range: z.enum(['today', 'tomorrow', 'this_week', 'next_week']).optional(),
        start: z.string().min(1).optional(),
        end: z.string().min(1).optional(),
        resourceIds: z.array(z.number().int().min(1)).optional(),
      },
    },
    async (args) => {
      let start: string;
      let end: string;
      if (args.start && args.end) {
        start = args.start;
        end = args.end;
      } else {
        const window = resolveCalendarRange(args.range ?? 'this_week');
        start = window.start;
        end = window.end;
      }
      const client = await context.getClient();
      const events = await client.getCalendarEvents({
        profileIds: args.profileIds,
        start,
        end,
        ...(args.resourceIds ? { resourceIds: args.resourceIds } : {}),
      });
      const localizedEvents = events.map((event) => ({
        ...event,
        startDateTime: toCopenhagenIso(event.startDateTime),
        endDateTime: toCopenhagenIso(event.endDateTime),
      }));
      return jsonContent(localizedEvents);
    },
  );

  // --- aula_notifications_list ---------------------------------------------

  server.registerTool(
    'aula_notifications_list',
    {
      title: 'Aula notifications',
      description: 'Unread items + activity for the active guardian profile.',
      inputSchema: {},
    },
    async () => {
      const client = await context.getClient();
      return jsonContent(
        compactNotifications(await client.getNotifications()),
      );
    },
  );

  // --- aula_posts_list -----------------------------------------------------

  server.registerTool(
    'aula_posts_list',
    {
      title: 'Aula posts (class news feed)',
      description:
        'Teacher posts and class-level updates — the "Opslag" feed in the Aula app, ' +
        'including read posts. By default fans out across every group the guardian ' +
        'has access to and merges results, sorted newest first. To inspect one specific post ' +
        'and read its PDF/DOCX/TXT attachments in the same call, pass that postId together ' +
        'with includeAttachmentText=true. Pass `institutionProfileIds` only to use the ' +
        'legacy unread-only feed.',
      inputSchema: {
        institutionProfileIds: z
          .array(z.number().int().min(1))
          .min(1)
          .optional()
          .describe(
            'Legacy unread-only feed (advances profileLastSeenPostDate on every call). ' +
              'Prefer the default group fan-out unless you specifically want unread state.',
          ),
        postId: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Return only this Aula post id. Use a post id previously returned by aula_posts_list.',
          ),
        includeAttachmentText: z
          .boolean()
          .optional()
          .describe(
            'When true, parse readable PDF/DOCX/TXT attachments directly into the returned post. Requires postId.',
          ),
        limit: z.number().int().min(1).max(50).optional(),
        index: z
          .string()
          .min(1)
          .optional()
          .describe('Numeric postId cursor (Aula 400s on date strings). Omit for the first page.'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      const limit = args.limit ?? 20;

      if (args.includeAttachmentText && args.postId === undefined) {
        return jsonContent({
          error: 'includeAttachmentText requires postId',
          note:
            'First find the post with aula_posts_list, then call aula_posts_list again with that postId and includeAttachmentText=true.',
        });
      }

      // Mode 1: explicit institutionProfileIds (legacy unread feed).
      if (args.institutionProfileIds?.length) {
        return jsonContent(
          compactPostsResponse(
            await client.getPosts({
              institutionProfileIds: args.institutionProfileIds,
              limit,
              ...(args.index !== undefined ? { index: args.index } : {}),
            }),
          ),
        );
      }

      // Mode 2 (default): fan out across all groups, merge, dedupe by id,
      // sort newest first. This is the only mode that returns already-read
      // posts — Aula's institutionProfile-scoped feed only ever shows unread.
      const [groupIds, groupMeta] = await Promise.all([
        context.getGroupIds(),
        context.getGroupMeta(),
      ]);
      if (groupIds.length === 0) {
        return jsonContent({
          posts: [],
          _note:
            'No groups discovered from profileContext.institutions[].groups + ' +
            'municipalGroups. Either the guardian has no group memberships, or ' +
            "getProfileContext('guardian') failed.",
        });
      }
      const seen = new Set<number>();
      const merged: Array<
        Record<string, unknown> & {
          _groupId: number;
          _institutionCode?: string;
          _institutionName?: string;
          _groupName?: string;
        }
      > = [];
      const errors: Array<{ groupId: number; error: string }> = [];
      // perGroupLimit kept modest — most groups have <20 posts in the window.
      const perGroupLimit = Math.max(limit, 20);
      await Promise.all(
        groupIds.map(async (gid) => {
          try {
            const raw = (await client.getPosts({ groupId: gid, limit: perGroupLimit })) as {
              posts?: Array<Record<string, unknown>>;
            };
            const meta = groupMeta.get(gid);
            for (const post of raw.posts ?? []) {
              const idVal = post.id ?? (post as { postId?: unknown }).postId;
              const id = typeof idVal === 'number' ? idVal : Number(idVal);
              if (!Number.isFinite(id) || seen.has(id)) continue;
              seen.add(id);
              merged.push({
                ...post,
                _groupId: gid,
                ...(meta?.institutionCode ? { _institutionCode: meta.institutionCode } : {}),
                ...(meta?.institutionName ? { _institutionName: meta.institutionName } : {}),
                ...(meta?.name ? { _groupName: meta.name } : {}),
              });
            }
          } catch (e) {
            errors.push({ groupId: gid, error: (e as Error).message });
          }
        }),
      );
      // Sort by best-available date field, newest first.
      const dateOf = (p: Record<string, unknown>): number => {
        const raw =
          (p.publishAt as string | undefined) ??
          (p.timestamp as string | undefined) ??
          (p.createdAt as string | undefined) ??
          (p.publishDate as string | undefined);
        return raw ? Date.parse(raw) : 0;
      };
      merged.sort((a, b) => dateOf(b) - dateOf(a));

      const selectedPosts =
        args.postId !== undefined
          ? merged.filter((post) => {
              const idValue = post.id ?? post.postId;
              return Number(idValue) === args.postId;
            })
          : merged.slice(0, limit);

      const compactedPosts = selectedPosts.map(compactPost);

      if (args.includeAttachmentText) {
        await Promise.all(
          selectedPosts.map(async (rawPost, postIndex) => {
            const compactedPost = compactedPosts[postIndex];
            const rawAttachments = Array.isArray(rawPost.attachments)
              ? rawPost.attachments
              : [];

            const compactAttachments = Array.isArray(compactedPost.attachments)
              ? (compactedPost.attachments as Array<Record<string, unknown>>)
              : [];

            await Promise.all(
              rawAttachments.map(async (rawAttachment) => {
                if (!rawAttachment || typeof rawAttachment !== 'object') return;

                const attachment = rawAttachment as Record<string, unknown>;
                const fileObject =
                  attachment.file && typeof attachment.file === 'object'
                    ? (attachment.file as Record<string, unknown>)
                    : undefined;

                const attachmentIdRaw =
                  attachment.id ?? fileObject?.id;
                const attachmentId =
                  typeof attachmentIdRaw === 'number'
                    ? attachmentIdRaw
                    : Number(attachmentIdRaw);

                if (!Number.isFinite(attachmentId)) return;

                const compactAttachment = compactAttachments.find(
                  (candidate) => Number(candidate.id) === attachmentId,
                );

                if (!compactAttachment || compactAttachment.readable !== true) {
                  return;
                }

                const name =
                  typeof attachment.name === 'string'
                    ? attachment.name
                    : typeof fileObject?.name === 'string'
                      ? fileObject.name
                      : `attachment-${attachmentId}`;

                const url =
                  typeof fileObject?.url === 'string'
                    ? fileObject.url
                    : undefined;

                if (!url) {
                  compactAttachment.readError =
                    'Attachment has no downloadable file URL';
                  return;
                }

                const parsed = await parseAttachmentFile(name, url);
                Object.assign(compactAttachment, parsed);
              }),
            );
          }),
        );
      }

      return jsonContent({
        posts: compactedPosts,
        _source: 'groups',
        _groupsQueried: groupIds.length,
        _postsFound: merged.length,
        ...(args.postId !== undefined && compactedPosts.length === 0
          ? { _note: `Post ${args.postId} was not found in the fetched group history.` }
          : {}),
        ...(errors.length > 0 ? { _errors: errors } : {}),
      });
    },
  );

  // --- aula_posts_search ---------------------------------------------------

  server.registerTool(
    'aula_posts_search',
    {
      title: 'Search Aula posts',
      description:
        'Search read and unread Aula posts across all groups available to the guardian. ' +
        'Use this when the user refers to a post by title, topic or wording. Returns only ' +
        'the best matching posts instead of the full feed. By default readable PDF/DOCX/TXT ' +
        'attachments on matching posts are parsed and included directly as attachment.text.',
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe(
            'Words or title text to search for, e.g. "medbringe materialer næste uge".',
          ),
        includeAttachmentText: z
          .boolean()
          .optional()
          .describe(
            'Parse readable PDF/DOCX/TXT attachments on matching posts. Defaults to true.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum number of matching posts to return. Defaults to 5.'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      const [groupIds, groupMeta] = await Promise.all([
        context.getGroupIds(),
        context.getGroupMeta(),
      ]);

      if (groupIds.length === 0) {
        return jsonContent({
          query: args.query,
          posts: [],
          _note:
            'No groups discovered from profileContext.institutions[].groups + municipalGroups.',
        });
      }

      const seen = new Set<number>();
      const merged: Array<
        Record<string, unknown> & {
          _groupId: number;
          _institutionCode?: string;
          _institutionName?: string;
          _groupName?: string;
        }
      > = [];
      const errors: Array<{ groupId: number; error: string }> = [];

      await Promise.all(
        groupIds.map(async (gid) => {
          try {
            const raw = (await client.getPosts({
              groupId: gid,
              limit: 50,
            })) as {
              posts?: Array<Record<string, unknown>>;
            };

            const meta = groupMeta.get(gid);

            for (const post of raw.posts ?? []) {
              const idValue = post.id ?? post.postId;
              const id =
                typeof idValue === 'number'
                  ? idValue
                  : Number(idValue);

              if (!Number.isFinite(id) || seen.has(id)) continue;

              seen.add(id);

              merged.push({
                ...post,
                _groupId: gid,
                ...(meta?.institutionCode
                  ? { _institutionCode: meta.institutionCode }
                  : {}),
                ...(meta?.institutionName
                  ? { _institutionName: meta.institutionName }
                  : {}),
                ...(meta?.name
                  ? { _groupName: meta.name }
                  : {}),
              });
            }
          } catch (error) {
            errors.push({
              groupId: gid,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        }),
      );

      const normalizeSearch = (value: unknown): string =>
        typeof value === 'string'
          ? value
              .toLocaleLowerCase('da-DK')
              .replace(/[^\p{L}\p{N}]+/gu, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          : '';

      const query = normalizeSearch(args.query);
      const terms = query
        .split(' ')
        .filter((term) => term.length >= 2);

      const scored = merged
        .map((post) => {
          const title = normalizeSearch(post.title);

          const content =
            post.content &&
            typeof post.content === 'object'
              ? (post.content as { html?: unknown })
              : undefined;

          const body = normalizeSearch(
            htmlToText(content?.html) ??
              (typeof post.text === 'string'
                ? post.text
                : ''),
          );

          let score = 0;

          if (title === query) score += 200;
          else if (title.includes(query)) score += 120;

          if (body.includes(query)) score += 60;

          for (const term of terms) {
            if (title.includes(term)) score += 20;
            if (body.includes(term)) score += 5;
          }

          const dateRaw =
            (post.publishAt as string | undefined) ??
            (post.timestamp as string | undefined) ??
            (post.createdAt as string | undefined) ??
            (post.publishDate as string | undefined);

          const timestamp = dateRaw
            ? Date.parse(dateRaw)
            : 0;

          return {
            post,
            score,
            timestamp,
          };
        })
        .filter((item) => item.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.timestamp - a.timestamp,
        );

      const selected = scored
        .slice(0, args.limit ?? 5)
        .map((item) => item.post);

      const compactedPosts = selected.map(compactPost);

      if (args.includeAttachmentText ?? true) {
        await Promise.all(
          selected.map(async (rawPost, postIndex) => {
            const compactedPost = compactedPosts[postIndex];

            const rawAttachments = Array.isArray(rawPost.attachments)
              ? rawPost.attachments
              : [];

            const compactAttachments = Array.isArray(
              compactedPost.attachments,
            )
              ? (compactedPost.attachments as Array<
                  Record<string, unknown>
                >)
              : [];

            await Promise.all(
              rawAttachments.map(async (rawAttachment) => {
                if (
                  !rawAttachment ||
                  typeof rawAttachment !== 'object'
                ) {
                  return;
                }

                const attachment =
                  rawAttachment as Record<string, unknown>;

                const fileObject =
                  attachment.file &&
                  typeof attachment.file === 'object'
                    ? (attachment.file as Record<
                        string,
                        unknown
                      >)
                    : undefined;

                const attachmentIdRaw =
                  attachment.id ?? fileObject?.id;

                const attachmentId =
                  typeof attachmentIdRaw === 'number'
                    ? attachmentIdRaw
                    : Number(attachmentIdRaw);

                if (!Number.isFinite(attachmentId)) return;

                const compactAttachment =
                  compactAttachments.find(
                    (candidate) =>
                      Number(candidate.id) ===
                      attachmentId,
                  );

                if (
                  !compactAttachment ||
                  compactAttachment.readable !== true
                ) {
                  return;
                }

                const name =
                  typeof attachment.name === 'string'
                    ? attachment.name
                    : typeof fileObject?.name === 'string'
                      ? fileObject.name
                      : `attachment-${attachmentId}`;

                const url =
                  typeof fileObject?.url === 'string'
                    ? fileObject.url
                    : undefined;

                if (!url) {
                  compactAttachment.readError =
                    'Attachment has no downloadable file URL';
                  return;
                }

                Object.assign(
                  compactAttachment,
                  await parseAttachmentFile(name, url),
                );
              }),
            );
          }),
        );
      }

      return jsonContent({
        query: args.query,
        posts: compactedPosts,
        _groupsQueried: groupIds.length,
        _postsScanned: merged.length,
        _matchesFound: scored.length,
        ...(errors.length > 0
          ? { _errors: errors }
          : {}),
      });
    },
  );

  // --- aula_attachment_read ------------------------------------------------

  server.registerTool(
    'aula_attachment_read',
    {
      title: 'Read Aula attachment',
      description:
        'Download and extract text from an attachment belonging to an Aula post. ' +
        'When aula_posts_list returns an attachment with readable=true and a readWith object, ' +
        'use this tool and pass exactly readWith.postId and readWith.attachmentId. Do not use ' +
        'aula_messages_get_thread for post attachments. Supports PDF, DOCX and TXT. ' +
        'Signed download URLs are used internally and are never returned.',
      inputSchema: {
        postId: z.number().int().min(1),
        attachmentId: z.number().int().min(1),
      },
    },
    async (args) => {
      const client = await context.getClient();
      const groupIds = await context.getGroupIds();

      let matchedPost: Record<string, unknown> | undefined;
      let matchedAttachment: Record<string, unknown> | undefined;

      for (const groupId of groupIds) {
        const raw = (await client.getPosts({
          groupId,
          limit: 50,
        })) as {
          posts?: Array<Record<string, unknown>>;
        };

        const post = (raw.posts ?? []).find((candidate) => {
          const idValue = candidate.id ?? candidate.postId;
          return Number(idValue) === args.postId;
        });

        if (!post) continue;

        const attachments = Array.isArray(post.attachments)
          ? post.attachments
          : [];

        const attachment = attachments.find((candidate) => {
          if (!candidate || typeof candidate !== 'object') return false;
          const item = candidate as Record<string, unknown>;

          const directId = item.id;
          if (typeof directId === 'number' && directId === args.attachmentId) {
            return true;
          }

          const file = item.file;
          if (file && typeof file === 'object') {
            return (file as Record<string, unknown>).id === args.attachmentId;
          }

          return false;
        });

        if (attachment && typeof attachment === 'object') {
          matchedPost = post;
          matchedAttachment = attachment as Record<string, unknown>;
          break;
        }
      }

      if (!matchedPost || !matchedAttachment) {
        return jsonContent({
          error: 'Attachment not found',
          postId: args.postId,
          attachmentId: args.attachmentId,
        });
      }

      const fileObject =
        matchedAttachment.file && typeof matchedAttachment.file === 'object'
          ? (matchedAttachment.file as Record<string, unknown>)
          : undefined;

      const name =
        typeof matchedAttachment.name === 'string'
          ? matchedAttachment.name
          : typeof fileObject?.name === 'string'
            ? fileObject.name
            : `attachment-${args.attachmentId}`;

      const url =
        typeof fileObject?.url === 'string'
          ? fileObject.url
          : undefined;

      if (!url) {
        return jsonContent({
          error: 'Attachment has no downloadable file URL',
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
        });
      }

      const parsed = await parseAttachmentFile(name, url);

      return jsonContent({
        postId: args.postId,
        attachmentId: args.attachmentId,
        name,
        ...parsed,
      });
    },
  );

  // --- aula_raw_request (gated) --------------------------------------------

  if (process.env.AULA_MCP_RAW === '1') {
    server.registerTool(
      'aula_raw_request',
      {
        title: 'Raw Aula API call (escape hatch)',
        description:
          'Call any Aula API method directly. Enabled when AULA_MCP_RAW=1. The CSRF token + ' +
          'access_token are added automatically; the response envelope is unwrapped to its ' +
          '`data` field. Use sparingly — most needs have a typed tool.',
        inputSchema: {
          method: z.string().min(1).describe('e.g. "profiles.getProfileContext"'),
          query: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
        },
      },
      async (args) => {
        const client = await context.getClient();
        return jsonContent(await client.rawRequest(args.method, args.query ?? {}, args.body));
      },
    );
  }


  // --- aula_attention_context -----------------------------------------------

  server.registerTool(
    'aula_attention_context',
    {
      title: 'Aula attention context',
      description:
        'Build a deterministic compact context for family attention summaries. ' +
        'Returns today/tomorrow school schedule for every discovered child, recent posts ' +
        'with child/group metadata, and recent message-thread metadata. Use this instead ' +
        'of independently discovering data for each child when building a family dashboard summary.',
      inputSchema: {
        mode: z
          .enum(['all', 'school', 'messages'])
          .optional()
          .describe(
            'Response mode. "school" returns only school/calendar/post attention data, ' +
            '"messages" returns only message attention data, and "all" returns both. ' +
            'Defaults to "all".',
          ),
        postLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of recent posts to include. Defaults to 30.'),
        messageLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of recent message threads to include. Defaults to 30.'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      const mode = args.mode ?? 'all';

      const discover = await buildDiscoverManifest(context);

      const children = Array.isArray(discover.children)
        ? discover.children
        : [];

      const schedule = await Promise.all(
        children.map(async (child) => {
          const profileId = child.institution?.id;

          if (typeof profileId !== 'number') {
            return {
              id: child.id,
              name: child.name,
              today: [],
              tomorrow: [],
              next14Days: [],
              error: 'Missing child institution profile id',
            };
          }

          const todayRange = resolveCalendarRange('today');
          const tomorrowRange = resolveCalendarRange('tomorrow');

          const fourteenDayStart = startOfDayCopenhagen(new Date());
          const fourteenDayRange = {
            start: aulaTs(fourteenDayStart),
            end: aulaTs(addDays(fourteenDayStart, 14)),
          };

          const [
            todayEvents,
            tomorrowEvents,
            next14DaysEvents,
          ] = await Promise.all([
            client.getCalendarEvents({
              profileIds: [profileId],
              start: todayRange.start,
              end: todayRange.end,
            }),
            client.getCalendarEvents({
              profileIds: [profileId],
              start: tomorrowRange.start,
              end: tomorrowRange.end,
            }),
            client.getCalendarEvents({
              profileIds: [profileId],
              start: fourteenDayRange.start,
              end: fourteenDayRange.end,
            }),
          ]);

          const compactCalendarEvents = (
            events: Awaited<
              ReturnType<typeof client.getCalendarEvents>
            >,
          ) => {
            const seenEvents = new Set<string>();

            return events
              .map((event) => {
                const start = toCopenhagenIso(
                  event.startDateTime,
                );
                const end = toCopenhagenIso(
                  event.endDateTime,
                );

                return {
                  title: event.title,
                  start,
                  end,
                };
              })
              .filter((event) => {
                const key = `${event.title ?? ''}|${event.start}|${event.end}`;

                if (seenEvents.has(key)) {
                  return false;
                }

                seenEvents.add(key);
                return true;
              })
              .sort(
                (a, b) =>
                  Date.parse(a.start) - Date.parse(b.start),
              );
          };

          return {
            id: child.id,
            name: child.name,
            today: compactCalendarEvents(todayEvents),
            tomorrow: compactCalendarEvents(tomorrowEvents),
            next14Days: compactCalendarEvents(next14DaysEvents),
          };
        }),
      );

      // ------------------------------------------------------------
      // Guardian calendar invitations requiring a response
      // ------------------------------------------------------------

      const guardianProfileIds = Array.isArray(discover.institutionProfileIds)
        ? discover.institutionProfileIds.filter(
            (id): id is number => typeof id === 'number',
          )
        : [];

      const guardianRangeStart = startOfDayCopenhagen(new Date());
      const guardianRange = {
        start: aulaTs(guardianRangeStart),
        end: aulaTs(addDays(guardianRangeStart, 30)),
      };

      const guardianCalendarEvents =
        guardianProfileIds.length > 0
          ? await client.getCalendarEvents({
              profileIds: guardianProfileIds,
              start: guardianRange.start,
              end: guardianRange.end,
            })
          : [];

      const childNameByInstitutionProfileId = new Map<number, string>();

      for (const child of children) {
        const profileId = child.institution?.id;

        if (
          typeof profileId === 'number' &&
          typeof child.name === 'string'
        ) {
          childNameByInstitutionProfileId.set(
            profileId,
            child.name,
          );
        }
      }

      const calendarInvitations = guardianCalendarEvents
        .filter(
          (event) =>
            event.responseRequired === true &&
            event.responseStatus === 'waiting',
        )
        .map((event) => {
          const belongsToProfiles = Array.isArray(
            event.belongsToProfiles,
          )
            ? event.belongsToProfiles.filter(
                (id): id is number => typeof id === 'number',
              )
            : [];

          const appliesToChildren = belongsToProfiles
            .map((id) =>
              childNameByInstitutionProfileId.get(id),
            )
            .filter(
              (name): name is string =>
                typeof name === 'string',
            );

          return {
            eventId: event.id,
            title: event.title,
            start: toCopenhagenIso(event.startDateTime),
            end: toCopenhagenIso(event.endDateTime),
            responseStatus: event.responseStatus,
            ...(typeof event.responseDeadline === 'string'
              ? {
                  responseDeadline: toCopenhagenIso(
                    event.responseDeadline,
                  ),
                }
              : {}),
            ...(typeof event.additionalResourceText === 'string' &&
            event.additionalResourceText.length > 0
              ? {
                  details: event.additionalResourceText,
                }
              : {}),
            ...(appliesToChildren.length > 0
              ? { appliesToChildren }
              : {}),
          };
        })
        .sort(
          (a, b) =>
            Date.parse(a.start) - Date.parse(b.start),
        );

      const postLimit = args.postLimit ?? 30;

      const [groupIds, groupMeta] = await Promise.all([
        context.getGroupIds(),
        context.getGroupMeta(),
      ]);

      const seen = new Set<number>();
      const mergedPosts: Array<Record<string, unknown>> = [];
      const postErrors: Array<{ groupId: number; error: string }> = [];

      await Promise.all(
        groupIds.map(async (groupId) => {
          try {
            const raw = (await client.getPosts({
              groupId,
              limit: Math.max(postLimit, 20),
            })) as {
              posts?: Array<Record<string, unknown>>;
            };

            const meta = groupMeta.get(groupId);

            for (const post of raw.posts ?? []) {
              const idValue = post.id ?? post.postId;
              const id =
                typeof idValue === 'number'
                  ? idValue
                  : Number(idValue);

              if (!Number.isFinite(id) || seen.has(id)) continue;

              seen.add(id);

              mergedPosts.push({
                ...post,
                _groupId: groupId,
                ...(meta?.institutionCode
                  ? { _institutionCode: meta.institutionCode }
                  : {}),
                ...(meta?.institutionName
                  ? { _institutionName: meta.institutionName }
                  : {}),
                ...(meta?.name
                  ? { _groupName: meta.name }
                  : {}),
              });
            }
          } catch (error) {
            postErrors.push({
              groupId,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        }),
      );

      const dateOf = (post: Record<string, unknown>): number => {
        const raw =
          (post.publishAt as string | undefined) ??
          (post.timestamp as string | undefined) ??
          (post.createdAt as string | undefined) ??
          (post.publishDate as string | undefined);

        return raw ? Date.parse(raw) : 0;
      };

      mergedPosts.sort((a, b) => dateOf(b) - dateOf(a));

      const compactedPosts = mergedPosts
        .slice(0, postLimit)
        .map(compactPost);

      const childNames = children
        .map((child) => child.name)
        .filter(
          (name): name is string =>
            typeof name === 'string' && name.length > 0,
        );

      const postsByChild: Record<
        string,
        Array<Record<string, unknown>>
      > = Object.fromEntries(
        childNames.map((name) => [name, []]),
      );

      const sharedPosts: Array<Record<string, unknown>> = [];

      for (const post of compactedPosts) {
        const postChildren = Array.isArray(post.children)
          ? post.children.filter(
              (name): name is string =>
                typeof name === 'string',
            )
          : [];

        const matchedChildren = childNames.filter((name) =>
          postChildren.includes(name),
        );

        if (matchedChildren.length === 1) {
          postsByChild[matchedChildren[0]].push(post);
          continue;
        }

        sharedPosts.push({
          ...post,
          ...(matchedChildren.length > 0
            ? { appliesToChildren: matchedChildren }
            : {}),
        });
      }

      const threads = await client.getThreads({
        page: 0,
        pageSize: args.messageLimit ?? 30,
      });

      const messages = threads.map((thread) => ({
        id: thread.id,
        read: thread.read,
        ...(thread.subject
          ? { subject: thread.subject }
          : {}),
        ...(thread.lastMessage?.sendDateTime
          ? {
              lastMessageDate: toCopenhagenIso(
                thread.lastMessage.sendDateTime,
              ),
            }
          : {}),
        ...(thread.lastMessage?.sender?.fullName
          ? {
              lastSender:
                thread.lastMessage.sender.fullName,
            }
          : {}),
      }));

      const actionSubjectPattern =
        /(fødselsdag|invitation|tilmeld|betaling|betal|svar|deadline|frist|tur|udflugt|møde|forældremøde|lejrskole|skolefest|arrangement)/i;

      const messageActionCandidates = messages.filter((message) => {
        const subject =
          typeof message.subject === 'string'
            ? message.subject
            : '';

        return actionSubjectPattern.test(subject);
      });

      const rawMessageThreads = await Promise.all(
        messageActionCandidates.map(async (candidate) => {
          const threadId =
            typeof candidate.id === 'number'
              ? candidate.id
              : Number(candidate.id);

          if (!Number.isFinite(threadId)) {
            return {
              threadId: candidate.id,
              subject: candidate.subject,
              error: 'Invalid thread id',
            };
          }

          try {
            const thread = await client.getMessagesForThread(threadId, {
              page: 0,
            });

            const threadRecord =
              thread && typeof thread === 'object'
                ? (thread as Record<string, unknown>)
                : {};

            const rawMessages = Array.isArray(threadRecord.messages)
              ? threadRecord.messages
              : [];

            const compactMessages = rawMessages
              .filter(
                (message): message is Record<string, unknown> =>
                  Boolean(message) && typeof message === 'object',
              )
              .map((message) => {
                const textObject =
                  message.text && typeof message.text === 'object'
                    ? (message.text as Record<string, unknown>)
                    : undefined;

                const senderObject =
                  message.sender && typeof message.sender === 'object'
                    ? (message.sender as Record<string, unknown>)
                    : undefined;

                const html =
                  typeof textObject?.html === 'string'
                    ? textObject.html
                    : undefined;

                const plainText = htmlToText(html);

                return {
                  ...(typeof message.sendDateTime === 'string'
                    ? {
                        sendDateTime: toCopenhagenIso(
                          message.sendDateTime,
                        ),
                      }
                    : {}),
                  ...(typeof senderObject?.fullName === 'string'
                    ? { sender: senderObject.fullName }
                    : {}),
                  ...(plainText ? { text: plainText } : {}),
                  ...(typeof message.messageType === 'string'
                    ? { messageType: message.messageType }
                    : {}),
                };
              })
              .filter(
                (message) =>
                  typeof message.text === 'string' &&
                  message.text.length > 0,
              );

            return {
              threadId,
              subject:
                typeof threadRecord.subject === 'string'
                  ? threadRecord.subject
                  : candidate.subject,
              messages: compactMessages,
            };
          } catch (error) {
            return {
              threadId,
              subject: candidate.subject,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            };
          }
        }),
      );

      const messageThreadCutoff =
        Date.now() - 45 * 24 * 60 * 60 * 1000;

      const messageThreads = rawMessageThreads.filter((thread) => {
        if (!('messages' in thread) || !Array.isArray(thread.messages)) {
          return true;
        }

        const newestMessageTime = thread.messages.reduce(
          (latest, message) => {
            const raw =
              typeof message.sendDateTime === 'string'
                ? Date.parse(message.sendDateTime)
                : 0;

            return Number.isFinite(raw) && raw > latest
              ? raw
              : latest;
          },
          0,
        );

        return (
          newestMessageTime === 0 ||
          newestMessageTime >= messageThreadCutoff
        );
      });

      // ------------------------------------------------------------
      // Deterministic action candidates
      //
      // These candidates are intentionally conservative. They do not
      // try to understand the full semantics of Aula content. Their
      // purpose is to make potentially actionable sources explicit so
      // the downstream model cannot easily overlook them.
      // ------------------------------------------------------------

      const calendarActionPattern =
        /\b(idræt|svøm|svømning|tur|udflugt|museum|lejrskole|ekskursion|aqua|skolefest|arrangement|projekt)\b/i;

      const calendarActionCandidates: Record<
        string,
        Array<Record<string, unknown>>
      > = {};

      for (const child of schedule) {
        const childName =
          typeof child.name === 'string'
            ? child.name
            : String(child.id ?? 'unknown');

        const events = Array.isArray(child.next14Days)
          ? child.next14Days
          : [];

        const candidates = events
          .filter((event) => {
            if (!event || typeof event !== 'object') return false;

            const candidate = event as Record<string, unknown>;
            const title =
              typeof candidate.title === 'string'
                ? candidate.title
                : '';

            return calendarActionPattern.test(title);
          })
          .map((event) => event as Record<string, unknown>)
          .sort((a, b) => {
            const aStart =
              typeof a.start === 'string'
                ? Date.parse(a.start)
                : 0;
            const bStart =
              typeof b.start === 'string'
                ? Date.parse(b.start)
                : 0;

            return aStart - bStart;
          });

        const merged: Array<Record<string, unknown>> = [];

        for (const candidate of candidates) {
          const previous = merged[merged.length - 1];

          const title =
            typeof candidate.title === 'string'
              ? candidate.title
              : '';

          const start =
            typeof candidate.start === 'string'
              ? candidate.start
              : '';

          const end =
            typeof candidate.end === 'string'
              ? candidate.end
              : '';

          if (
            previous &&
            previous.title === title &&
            previous.end === start
          ) {
            previous.end = end;
            continue;
          }

          merged.push({ ...candidate });
        }

        const todayDate = formatCopenhagenDate(new Date());
        const tomorrowDate = formatCopenhagenDate(
          addDays(startOfDayCopenhagen(new Date()), 1),
        );

        calendarActionCandidates[childName] = merged.map((candidate) => {
          const start =
            typeof candidate.start === 'string'
              ? candidate.start
              : '';

          const eventDate =
            start.length > 0
              ? formatCopenhagenDate(new Date(start))
              : undefined;

          const dateBucket =
            eventDate === todayDate
              ? 'today'
              : eventDate === tomorrowDate
                ? 'tomorrow'
                : 'upcoming';

          return {
            ...candidate,
            ...(eventDate ? { eventDate } : {}),
            dateBucket,
            appliesToChild: childName,
          };
        });
      }

      const postActionPattern =
        /(medbring|husk|husk at|reminder|hjælp søges|skal have med|send|sende|tilmeld|tilmelding|betaling|betal|deadline|frist|svar|fødselsdag|invitation|tur|udflugt|museum|blicher|lejrskole|idræt|svøm|projekt|kæphest|materiale|mødetid|afgang|ændring|aflyst|aflysning)/i;

      const isActionPost = (
        post: Record<string, unknown>,
      ): boolean => {
        const title =
          typeof post.title === 'string'
            ? post.title
            : '';

        const body =
          typeof post.text === 'string'
            ? post.text
            : '';

        return postActionPattern.test(`${title}\n${body}`);
      };

      const withResolvedRelativeDate = (
        post: Record<string, unknown>,
      ): Record<string, unknown> => {
        const resolved = resolveRelativePostDate(post);

        return {
          ...post,
          ...(resolved ?? {}),
        };
      };

      const postActionCandidatesByChild: Record<
        string,
        Array<Record<string, unknown>>
      > = Object.fromEntries(
        Object.entries(postsByChild).map(([name, posts]) => [
          name,
          posts
            .filter(isActionPost)
            .map(withResolvedRelativeDate)
            .map((post) => ({
              ...post,
              appliesToChild: name,
            })),
        ]),
      );

      const sharedPostActionCandidates =
        sharedPosts
          .filter(isActionPost)
          .map(withResolvedRelativeDate);

      const schoolPayload = {
        children: schedule,
        posts: {
          byChild: postsByChild,
          shared: sharedPosts,
        },
        actionCandidates: {
          calendar: calendarActionCandidates,
          calendarInvitations,
          posts: {
            byChild: postActionCandidatesByChild,
            shared: sharedPostActionCandidates,
          },
        },
      };

      const messagePayload = {
        messages: {
          recent: messages,
          actionCandidates: messageActionCandidates,
        },
        actionCandidates: {
          messages: messageActionCandidates,
        },
      };

      const meta = {
        groupsQueried: groupIds.length,
        postsFound: mergedPosts.length,
        postLimit,
        messageLimit: args.messageLimit ?? 30,
        ...(postErrors.length > 0
          ? { postErrors }
          : {}),
      };

      if (mode === 'school') {
        return jsonContent({
          actionCandidates: schoolPayload.actionCandidates,
          _meta: meta,
        });
      }

      if (mode === 'messages') {
        return jsonContent({
          actionCandidates: {
            messages: messageActionCandidates,
          },
          messageThreads,
          _meta: meta,
        });
      }

      return jsonContent({
        ...schoolPayload,
        messages: messagePayload.messages,
        actionCandidates: {
          ...schoolPayload.actionCandidates,
          messages: messageActionCandidates,
        },
        _meta: meta,
      });
    },
  );

  // --- aula_messages_list_threads ------------------------------------------

  server.registerTool(
    'aula_messages_list_threads',
    {
      title: 'List Aula message threads',
      description: 'Most recent first. Use `page` for pagination (0-indexed).',
      inputSchema: {
        page: z.number().int().min(0).default(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const client = await context.getClient();
      const threads = await client.getThreads({
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      });
      return jsonContent(threads);
    },
  );

  // --- aula_ugeplan_* ------------------------------------------------------
  //
  // Each provider has its own tool. The agent picks the right one based on
  // the institution-to-provider mapping (currently: try whichever the
  // school uses; long term, plumb this into discover).

  const integrationContextShape = {
    childIds: z.array(z.number().int().min(1)).min(1),
    institutionCodes: z.array(z.string().min(1)).min(1),
    isoWeek: z
      .string()
      .regex(/^\d{4}-W\d{2}$/)
      .optional()
      .describe('ISO week, e.g. "2026-W18". Defaults to the current week.'),
  } as const;

  async function buildIntegrationCtx(args: {
    childIds: number[];
    institutionCodes: string[];
    isoWeek?: string | undefined;
  }) {
    const client = await context.getClient();
    const record = context.record;
    if (!record) throw new Error('AulaContext: no token record loaded');
    // EasyIQ / MU / Meebook want the numeric guardian user-id (from
    // getProfileContext). Systematic uses the literal MitID username for its
    // sessionId — that's the only integration where `sessionId` and the
    // numeric id differ. SystematicClient currently reads `ctx.sessionId`
    // (= username), so we keep that field as the username and put the
    // numeric id under `guardianId` for the other plugins.
    const guardianUserId = await context.getGuardianUserId();

    // SkolePortal's `x-childfilter` header takes the opaque per-child userId
    // (alphanumeric token), not the numeric child profile id. Look it up
    // from the profiles list, aligned with childIds by index. Missing → "".
    const profilesData = await client.getProfilesByLogin();
    const userIdByChildId = new Map<number, string>();
    for (const profile of profilesData.profiles ?? []) {
      for (const child of profile.children ?? []) {
        if (child.userId != null) {
          userIdByChildId.set(child.id, String(child.userId));
        }
      }
    }
    const childUserIds = args.childIds.map((id) => userIdByChildId.get(id) ?? '');

    return {
      isoWeek: args.isoWeek ?? isoWeekString(),
      sessionId: record.username,
      guardianId: guardianUserId,
      childIds: args.childIds,
      childUserIds,
      institutionCodes: args.institutionCodes,
    };
  }

  const integrationArgHint =
    'Pass childIds from aula_discover → children[].id, ' +
    'institutionCodes from children[].institution.code, ' +
    'and isoWeek as "YYYY-Www" for the target week (omit for current week). ' +
    'Returns the full week — filter by date in your response.';

  server.registerTool(
    'aula_ugeplan_easyiq',
    {
      title: 'EasyIQ weekly plan',
      description: `Weekly plan from EasyIQ for the given children. Use when the school is on EasyIQ. ${integrationArgHint}`,
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const easyiq = await context.getEasyIq();
      return jsonContent(await easyiq.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_ugeplan_meebook',
    {
      title: 'Meebook weekly plan',
      description: `Weekly plan from Meebook for the given children. Use when the school is on Meebook. ${integrationArgHint}`,
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const meebook = await context.getMeebook();
      return jsonContent(await meebook.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_ugeplan_easyiq_skoleportal',
    {
      title: 'EasyIQ SkolePortal weekly plan',
      description:
        'Weekly plan from EasyIQ SkolePortal (widget 0128) — a different EasyIQ product than ' +
        '`aula_ugeplan_easyiq` (widget 0001). Use when discover.detectedWidgets contains "0128". ' +
        integrationArgHint,
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const sp = await context.getEasyIqSkoleportal();
      return jsonContent(await sp.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_lektier_easyiq',
    {
      title: 'EasyIQ Lektier (homework)',
      description:
        'Homework items from EasyIQ Lektier (widget 0142) — same vendor as ' +
        '`aula_ugeplan_easyiq_skoleportal` but a separate "Lektier" product. ' +
        'Use when discover.detectedWidgets contains "0142".',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const lektier = await context.getEasyIqLektier();
      return jsonContent(await lektier.getLektier(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_opgaver_minuddannelse',
    {
      title: 'Min Uddannelse opgaveliste',
      description: 'Homework / task list from Min Uddannelse for the given children.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getOpgaver(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_ugebrev_minuddannelse',
    {
      title: 'Min Uddannelse ugebrev',
      description: 'Weekly newsletter (ugebrev) from Min Uddannelse.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getUgebrev(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula_huskelisten_systematic',
    {
      title: 'Systematic Huskelisten reminders',
      description:
        'Homework reminders from Systematic. Args may include `from`/`to` ISO YYYY-MM-DD dates.',
      inputSchema: {
        ...integrationContextShape,
        fromDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        toDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
    },
    async (args) => {
      const sys = await context.getSystematic();
      const baseCtx = await buildIntegrationCtx(args);
      return jsonContent(
        await sys.getReminders({
          ...baseCtx,
          ...(args.fromDate ? { fromDate: args.fromDate } : {}),
          ...(args.toDate ? { toDate: args.toDate } : {}),
        }),
      );
    },
  );

  // --- aula_messages_get_thread --------------------------------------------

  server.registerTool(
    'aula_messages_get_thread',
    {
      title: 'Read a single thread',
      description:
        'Returns subject + every message in the thread. Only use threadId values returned by ' +
        'aula_messages_list_threads. IDs returned by aula_posts_list are Aula post IDs, not ' +
        'message thread IDs, and must never be passed to this tool. If the thread is sensitive, ' +
        'this tool returns an error code that means the user must MitID step-up to read it ' +
        '(currently a fresh `aula login` from the CLI).',
      inputSchema: {
        threadId: z.number().int().min(1),
        page: z.number().int().min(0).default(0).optional(),
      },
    },
    async (args) => {
      const client = await context.getClient();
      try {
        return jsonContent(
          await client.getMessagesForThread(args.threadId, {
            ...(args.page !== undefined ? { page: args.page } : {}),
          }),
        );
      } catch (e) {
        if (e instanceof AulaStepUpRequiredError) {
          return jsonContent({
            error: 'step_up_required',
            message: e.message,
            hint: 'Run `aula login` again to refresh your session, then retry.',
          });
        }
        throw e;
      }
    },
  );
}
