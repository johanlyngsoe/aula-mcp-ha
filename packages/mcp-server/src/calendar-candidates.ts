import { createHash } from 'node:crypto';

export type CalendarValidationState = 'valid' | 'rejected';

export interface CalendarCandidate {
  sourceId: string;
  fingerprint: string;
  source:
    | 'aula-calendar'
    | 'aula-calendar-invitation'
    | 'aula-week-plan+post-attachment';
  child: string;
  activityType:
    | 'school_photography'
    | 'school_trip'
    | 'school_camp'
    | 'cinema_trip'
    | 'cycling_day'
    | 'school_party'
    | 'birthday_invitation';
  title: string;
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  details: string | null;
  responseStatus: string | null;
  confidence: 'deterministic';
  validation: {
    state: CalendarValidationState;
    reasons: string[];
  };
}

type RecordListByChild = Record<string, Array<Record<string, unknown>>>;

export interface CalendarCandidateInput {
  children: Array<Record<string, unknown>>;
  calendar: RecordListByChild;
  calendarInvitations: Array<Record<string, unknown>>;
  weekPlanByChild: RecordListByChild;
  postsByChild: RecordListByChild;
  sharedPosts: Array<Record<string, unknown>>;
}

const SPECIAL_ACTIVITY_PATTERNS: Array<[
  CalendarCandidate['activityType'],
  RegExp,
]> = [
  ['school_photography', /\b(foto(?:graf(?:ering)?)?|skoleportræt|portrætfoto)\b/i],
  ['school_camp', /\blejrskole\b/i],
  ['cinema_trip', /\b(biograf(?:tur)?|biograftur)\b/i],
  ['cycling_day', /\b(cykeldag|cykeltur)\b/i],
  ['school_party', /\bskolefest\b/i],
  ['school_trip', /\b(tur|udflugt|ekskursion|museumstur)\b/i],
];

const EXCLUDED_ACTIVITY_PATTERN =
  /\b(idræt|svømning|bibliotek|biblioteksbøger|lektier?|husk(?:epunkt)?)\b/i;

const ACCEPTED_RESPONSE_STATUSES = new Set([
  'accepted',
  'accept',
  'accepteret',
  'kommer',
  'attending',
  'yes',
]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function canonicalHash(parts: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 24);
}

function classifySpecialActivity(
  value: string,
): CalendarCandidate['activityType'] | undefined {
  if (EXCLUDED_ACTIVITY_PATTERN.test(value)) return undefined;

  return SPECIAL_ACTIVITY_PATTERNS.find(([, pattern]) =>
    pattern.test(value),
  )?.[0];
}

function validationFor(start?: string | null, end?: string | null): {
  state: CalendarValidationState;
  reasons: string[];
} {
  const reasons: string[] = [];
  const startTime = start ? Date.parse(start) : Number.NaN;
  const endTime = end ? Date.parse(end) : Number.NaN;

  if (!start || !Number.isFinite(startTime)) reasons.push('missing_or_invalid_start');
  if (!end || !Number.isFinite(endTime)) reasons.push('missing_or_invalid_end');
  if (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    endTime <= startTime
  ) {
    reasons.push('end_not_after_start');
  }

  return {
    state: reasons.length === 0 ? 'valid' : 'rejected',
    reasons,
  };
}

type CalendarCandidateDraft = Omit<
  CalendarCandidate,
  | 'fingerprint'
  | 'confidence'
  | 'validation'
  | 'start'
  | 'end'
  | 'location'
  | 'description'
  | 'details'
  | 'responseStatus'
> &
  Partial<
    Pick<
      CalendarCandidate,
      | 'start'
      | 'end'
      | 'location'
      | 'description'
      | 'details'
      | 'responseStatus'
    >
  >;

function makeCandidate(value: CalendarCandidateDraft): CalendarCandidate {
  const normalized = {
    ...value,
    start: value.start ?? null,
    end: value.end ?? null,
    location: value.location ?? null,
    description: value.description ?? null,
    details: value.details ?? null,
    responseStatus: value.responseStatus ?? null,
  };
  const validation = validationFor(normalized.start, normalized.end);
  const fingerprint = canonicalHash([
    normalized.source,
    normalized.sourceId,
    normalized.child,
    normalized.activityType,
    normalized.title,
    normalized.start,
    normalized.end,
    normalized.location,
  ]);

  return {
    ...normalized,
    fingerprint,
    confidence: 'deterministic',
    validation,
  };
}

function normalizeClassName(value: string): string {
  return value.toLocaleLowerCase('da-DK').replace(/[^0-9a-zæøå]/g, '');
}

function linesWithClass(attachmentText: string, className: string): string[] {
  const wanted = normalizeClassName(className);
  if (!wanted) return [];

  return attachmentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => normalizeClassName(line).includes(wanted));
}

function parseClockPair(line: string): { start: string; end: string } | undefined {
  const matches = [
    ...line.matchAll(/(?:kl\.?\s*)?(\d{1,2})[.:](\d{2})/gi),
  ];

  if (matches.length < 2) return undefined;

  const toClock = (match: RegExpMatchArray): string =>
    `${match[1].padStart(2, '0')}:${match[2]}:00`;

  return { start: toClock(matches[0]), end: toClock(matches[1]) };
}

function isoOnDate(date: string, clock: string): string {
  const offsetName = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  const offset = offsetName?.replace('GMT', '') || '+01:00';

  return `${date}T${clock}${offset}`;
}

function attachmentTexts(post: Record<string, unknown>): string[] {
  if (!Array.isArray(post.attachments)) return [];

  return post.attachments
    .filter(
      (attachment): attachment is Record<string, unknown> =>
        Boolean(attachment) && typeof attachment === 'object',
    )
    .map((attachment) => text(attachment.text))
    .filter((value): value is string => Boolean(value));
}

function postId(post: Record<string, unknown>): string {
  return String(post.id ?? post.postId ?? canonicalHash([post.title, post.text]));
}

export function buildCalendarCandidates(
  input: CalendarCandidateInput,
): CalendarCandidate[] {
  const candidates: CalendarCandidate[] = [];
  const classByChild = new Map<string, string>();

  for (const child of input.children) {
    const name = text(child.name);
    const className = text(child.className);
    if (name && className) classByChild.set(name, className);
  }

  for (const [child, events] of Object.entries(input.calendar)) {
    for (const event of events) {
      const title = text(event.title);
      if (!title) continue;

      const activityType = classifySpecialActivity(title);
      if (!activityType) continue;

      const start = text(event.start);
      const end = text(event.end);
      const location = text(event.location);
      const sourceId = `calendar:${String(
        event.eventId ?? event.id ?? canonicalHash([child, title, start, end]),
      )}`;

      candidates.push(
        makeCandidate({
          sourceId,
          source: 'aula-calendar',
          child,
          activityType,
          title,
          ...(start ? { start } : {}),
          ...(end ? { end } : {}),
          ...(location ? { location } : {}),
          ...(text(event.details) ? { details: text(event.details) } : {}),
        }),
      );
    }
  }

  for (const invitation of input.calendarInvitations) {
    const status = text(invitation.responseStatus)?.toLocaleLowerCase('da-DK');
    if (!status || !ACCEPTED_RESPONSE_STATUSES.has(status)) continue;

    const title = text(invitation.title);
    const children = Array.isArray(invitation.appliesToChildren)
      ? invitation.appliesToChildren.filter(
          (child): child is string =>
            typeof child === 'string' && child.length > 0,
        )
      : [];

    if (!title || children.length === 0 || !/\bfødselsdag\b/i.test(title)) {
      continue;
    }

    for (const child of children) {
      const start = text(invitation.start);
      const end = text(invitation.end);
      const sourceId = `invitation:${String(
        invitation.eventId ?? canonicalHash([title, start, end]),
      )}:${canonicalHash([child])}`;

      candidates.push(
        makeCandidate({
          sourceId,
          source: 'aula-calendar-invitation',
          child,
          activityType: 'birthday_invitation',
          title,
          ...(start ? { start } : {}),
          ...(end ? { end } : {}),
          ...(text(invitation.location)
            ? { location: text(invitation.location) }
            : {}),
          ...(text(invitation.details)
            ? {
                details: text(invitation.details),
                description: text(invitation.details),
              }
            : {}),
          responseStatus: status,
        }),
      );
    }
  }

  for (const [child, weekItems] of Object.entries(input.weekPlanByChild)) {
    const className = classByChild.get(child);
    if (!className) continue;

    const posts = [
      ...(input.postsByChild[child] ?? []),
      ...input.sharedPosts.filter((post) => {
        if (!Array.isArray(post.appliesToChildren)) return true;
        return post.appliesToChildren.includes(child);
      }),
    ];

    for (const item of weekItems) {
      const searchable = [item.subject, item.title, item.content]
        .map(text)
        .filter((value): value is string => Boolean(value))
        .join('\n');

      if (classifySpecialActivity(searchable) !== 'school_photography') {
        continue;
      }

      const date = text(item.resolvedDate) ?? text(item.date);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const matches: Array<{
        post: Record<string, unknown>;
        line: string;
        clocks: { start: string; end: string };
      }> = [];

      for (const post of posts) {
        for (const attachmentText of attachmentTexts(post)) {
          for (const line of linesWithClass(attachmentText, className)) {
            const clocks = parseClockPair(line);
            if (clocks) matches.push({ post, line, clocks });
          }
        }
      }

      const uniqueTimes = new Map(
        matches.map((match) => [
          `${match.clocks.start}|${match.clocks.end}`,
          match,
        ]),
      );

      if (uniqueTimes.size !== 1) continue;

      const match = [...uniqueTimes.values()][0];
      const start = isoOnDate(date, match.clocks.start);
      const end = isoOnDate(date, match.clocks.end);
      const sourceId = `week-plan-photo:${postId(match.post)}:${date}:${normalizeClassName(
        className,
      )}`;

      candidates.push(
        makeCandidate({
          sourceId,
          source: 'aula-week-plan+post-attachment',
          child,
          activityType: 'school_photography',
          title: 'Skolefotografering',
          start,
          end,
          description: searchable,
          details: match.line,
        }),
      );
    }
  }

  const byFingerprint = new Map<string, CalendarCandidate>();
  for (const candidate of candidates) {
    if (!byFingerprint.has(candidate.fingerprint)) {
      byFingerprint.set(candidate.fingerprint, candidate);
    }
  }

  return [...byFingerprint.values()].sort((a, b) => {
    const timeDifference =
      Date.parse(a.start ?? '') - Date.parse(b.start ?? '');
    if (Number.isFinite(timeDifference) && timeDifference !== 0) {
      return timeDifference;
    }
    return a.fingerprint.localeCompare(b.fingerprint);
  });
}
