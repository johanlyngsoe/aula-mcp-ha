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
  now?: Date;
}

const SPECIAL_ACTIVITY_PATTERNS: Array<[
  CalendarCandidate['activityType'],
  RegExp,
]> = [
  [
    'school_photography',
    /\b(foto(?:graf(?:ering)?)?|skolefoto|skoleportræt|portrætfoto)\b/i,
  ],
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

const DANISH_MONTHS: Record<string, number> = {
  jan: 1,
  januar: 1,
  feb: 2,
  februar: 2,
  mar: 3,
  marts: 3,
  apr: 4,
  april: 4,
  maj: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function copenhagenDateParts(value: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);

  return { year: part('year'), month: part('month'), day: part('day') };
}

function resolveDanishDate(value: string, now: Date): string | undefined {
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const numeric = value.match(
    /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?\b/,
  );
  const named = value
    .toLocaleLowerCase('da-DK')
    .match(
      /\b(\d{1,2})[.]?\s*(jan(?:uar)?|feb(?:ruar)?|mar(?:ts)?|apr(?:il)?|maj|jun(?:i)?|jul(?:i)?|aug(?:ust)?|sept?(?:ember)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?)[.]?/i,
    );

  const reference = copenhagenDateParts(now);
  const day = numeric ? Number(numeric[1]) : named ? Number(named[1]) : Number.NaN;
  const month = numeric
    ? Number(numeric[2])
    : named
      ? DANISH_MONTHS[named[2].toLocaleLowerCase('da-DK')]
      : Number.NaN;
  let year = numeric?.[3] ? Number(numeric[3]) : reference.year;

  if (!Number.isInteger(day) || !Number.isInteger(month)) return undefined;

  const referenceDay = Date.UTC(reference.year, reference.month - 1, reference.day);
  let candidateDay = Date.UTC(year, month - 1, day);

  if (!numeric?.[3] && candidateDay < referenceDay - 180 * 24 * 60 * 60 * 1000) {
    year += 1;
    candidateDay = Date.UTC(year, month - 1, day);
  }

  const date = new Date(candidateDay);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function classPattern(className: string): string | undefined {
  const normalized = normalizeClassName(className);
  const match = normalized.match(/^(\d{1,2})([a-zæøå])$/i);
  if (!match) return undefined;

  return `${match[1]}\\s*\\.?\\s*${match[2]}`;
}

function clock(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute}:00`;
}

function clockPairsForClass(
  value: string,
  className: string,
): Array<{ start: string; end: string; evidence: string }> {
  const klass = classPattern(className);
  if (!klass) return [];

  const time = '(\\d{1,2})[.:](\\d{2})';
  const afterClass = new RegExp(
    `${klass}\\s*:?\\s*(?:kl\\.?\\s*)?${time}\\s*[-–]\\s*${time}`,
    'gi',
  );
  const beforeClass = new RegExp(
    `${time}\\s*[-–]\\s*${time}\\s+${klass}(?![0-9A-Za-zÆØÅæøå])`,
    'gi',
  );
  const result: Array<{ start: string; end: string; evidence: string }> = [];

  for (const match of value.matchAll(afterClass)) {
    result.push({
      start: clock(match[1], match[2]),
      end: clock(match[3], match[4]),
      evidence: match[0],
    });
  }

  for (const match of value.matchAll(beforeClass)) {
    result.push({
      start: clock(match[1], match[2]),
      end: clock(match[3], match[4]),
      evidence: match[0],
    });
  }

  return result;
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

      const rawDate = text(item.resolvedDate) ?? text(item.date);
      const date = rawDate ? resolveDanishDate(rawDate, input.now ?? new Date()) : undefined;
      if (!date) continue;

      const matches: Array<{
        post?: Record<string, unknown>;
        start: string;
        end: string;
        evidence: string;
      }> = clockPairsForClass(searchable, className);

      for (const post of posts) {
        for (const attachmentText of attachmentTexts(post)) {
          for (const match of clockPairsForClass(attachmentText, className)) {
            matches.push({ post, ...match });
          }
        }
      }

      const uniqueTimes = new Map(
        matches.map((match) => [`${match.start}|${match.end}`, match]),
      );

      if (uniqueTimes.size !== 1) continue;

      const match = [...uniqueTimes.values()][0];
      const start = isoOnDate(date, match.start);
      const end = isoOnDate(date, match.end);
      const sourceId = `week-plan-photo:${
        match.post ? postId(match.post) : canonicalHash([child, searchable])
      }:${date}:${normalizeClassName(className)}`;

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
          details: match.evidence,
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
