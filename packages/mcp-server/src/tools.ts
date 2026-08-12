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
import { resolveCalendarRange } from './calendar-range.ts';
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
        'has access to and merges results, sorted newest first. Attachments that can ' +
        'be read by aula_attachment_read include a readWith object with the exact next tool call. ' +
        'Pass `institutionProfileIds` only to use the legacy unread-only feed.',
      inputSchema: {
        institutionProfileIds: z
          .array(z.number().int().min(1))
          .min(1)
          .optional()
          .describe(
            'Legacy unread-only feed (advances profileLastSeenPostDate on every call). ' +
              'Prefer the default group fan-out unless you specifically want unread state.',
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
      return jsonContent({
        posts: merged.slice(0, limit).map(compactPost),
        _source: 'groups',
        _groupsQueried: groupIds.length,
        _postsFound: merged.length,
        ...(errors.length > 0 ? { _errors: errors } : {}),
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

      const response = await fetch(url);

      if (!response.ok) {
        return jsonContent({
          error: `Attachment download failed with HTTP ${response.status}`,
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
        });
      }

      const declaredLength = Number(response.headers.get('content-length') ?? 0);

      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_ATTACHMENT_BYTES
      ) {
        return jsonContent({
          error: 'Attachment exceeds maximum supported size',
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
      }

      const bytes = Buffer.from(await response.arrayBuffer());

      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return jsonContent({
          error: 'Attachment exceeds maximum supported size',
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
      }

      const extension = extname(name).toLowerCase();
      let extractedText = '';
      let format: 'pdf' | 'docx' | 'txt';

      if (extension === '.pdf') {
        format = 'pdf';

        const workDir = await mkdtemp(join(tmpdir(), 'aula-attachment-'));
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
        return jsonContent({
          error: 'Unsupported attachment type',
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
          supportedTypes: ['pdf', 'docx', 'txt'],
        });
      }

      const normalizedText = normalizeAttachmentText(extractedText);

      if (format === 'pdf' && normalizedText.length < 20) {
        return jsonContent({
          postId: args.postId,
          attachmentId: args.attachmentId,
          name,
          format,
          text: normalizedText,
          ocrRequired: true,
          note:
            'The PDF contains little or no extractable text and may be scanned or image-based.',
        });
      }

      const output = truncateAttachmentText(normalizedText);

      return jsonContent({
        postId: args.postId,
        attachmentId: args.attachmentId,
        name,
        format,
        text: output.text,
        truncated: output.truncated,
        ocrRequired: false,
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
