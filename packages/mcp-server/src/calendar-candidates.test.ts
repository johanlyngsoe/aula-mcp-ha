import { describe, expect, test } from 'bun:test';
import { buildCalendarCandidates } from './calendar-candidates.ts';

describe('buildCalendarCandidates', () => {
  test('creates special calendar activities and excludes ordinary PE and library items', () => {
    const candidates = buildCalendarCandidates({
      children: [{ name: 'Barn A', className: '3.a' }],
      calendar: {
        'Barn A': [
          {
            title: 'Tur til museum',
            start: '2026-09-17T09:00:00+02:00',
            end: '2026-09-17T13:00:00+02:00',
          },
          {
            title: 'Idræt',
            start: '2026-09-18T10:00:00+02:00',
            end: '2026-09-18T11:00:00+02:00',
          },
          {
            title: 'Bibliotek',
            start: '2026-09-18T12:00:00+02:00',
            end: '2026-09-18T13:00:00+02:00',
          },
        ],
      },
      calendarInvitations: [],
      weekPlanByChild: {},
      postsByChild: {},
      sharedPosts: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      child: 'Barn A',
      activityType: 'school_trip',
      validation: { state: 'valid', reasons: [] },
      confidence: 'deterministic',
    });
    expect(candidates[0].sourceId).toMatch(/^calendar:/);
    expect(candidates[0].fingerprint).toHaveLength(24);
  });

  test('only creates accepted birthday invitations', () => {
    const baseInvitation = {
      title: 'Fødselsdag',
      start: '2026-09-20T11:00:00+02:00',
      end: '2026-09-20T14:00:00+02:00',
      appliesToChildren: ['Barn B'],
    };

    const candidates = buildCalendarCandidates({
      children: [{ name: 'Barn B', className: '1C' }],
      calendar: {},
      calendarInvitations: [
        { ...baseInvitation, eventId: 10, responseStatus: 'waiting' },
        { ...baseInvitation, eventId: 11, responseStatus: 'rejected' },
        { ...baseInvitation, eventId: 12, responseStatus: 'accepted' },
      ],
      weekPlanByChild: {},
      postsByChild: {},
      sharedPosts: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceId: expect.stringContaining('invitation:12:'),
      child: 'Barn B',
      activityType: 'birthday_invitation',
      responseStatus: 'accepted',
      validation: { state: 'valid', reasons: [] },
    });
  });

  test('derives photography time from dynamic class and week-plan date', () => {
    const candidates = buildCalendarCandidates({
      children: [
        { name: 'Barn A', className: '3.a' },
        { name: 'Barn B', className: '1C' },
      ],
      calendar: {},
      calendarInvitations: [],
      weekPlanByChild: {
        'Barn A': [
          {
            resolvedDate: '2026-09-15',
            subject: 'Foto',
            content: 'Klassen fotograferes.',
          },
        ],
        'Barn B': [
          {
            resolvedDate: '2026-09-16',
            subject: 'Fotografering',
            content: 'Klassen fotograferes.',
          },
        ],
      },
      postsByChild: {},
      sharedPosts: [
        {
          id: 42,
          title: 'Fotoplan',
          attachments: [
            {
              text: [
                '3A tirsdag 10.30 - 11.15',
                '1 C onsdag 10.30 - 11.15',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(
      candidates.map(({ child, start, end, validation }) => ({
        child,
        start,
        end,
        validation,
      })),
    ).toEqual([
      {
        child: 'Barn A',
        start: '2026-09-15T10:30:00+02:00',
        end: '2026-09-15T11:15:00+02:00',
        validation: { state: 'valid', reasons: [] },
      },
      {
        child: 'Barn B',
        start: '2026-09-16T10:30:00+02:00',
        end: '2026-09-16T11:15:00+02:00',
        validation: { state: 'valid', reasons: [] },
      },
    ]);
  });

  test('does not create photography when the dynamic class row is ambiguous', () => {
    const candidates = buildCalendarCandidates({
      children: [{ name: 'Barn A', className: '3A' }],
      calendar: {},
      calendarInvitations: [],
      weekPlanByChild: {
        'Barn A': [
          { resolvedDate: '2026-09-15', title: 'Fotografering' },
        ],
      },
      postsByChild: {},
      sharedPosts: [
        {
          id: 43,
          attachments: [
            {
              text: [
                '3.A kl. 10.30 - 11.15',
                '3 A kl. 12.00 - 12.45',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    expect(candidates).toEqual([]);
  });

  test('marks incomplete special events rejected instead of approving them', () => {
    const candidates = buildCalendarCandidates({
      children: [{ name: 'Barn A', className: '3A' }],
      calendar: {
        'Barn A': [
          {
            title: 'Lejrskole',
            start: '2026-10-01T08:00:00+02:00',
          },
        ],
      },
      calendarInvitations: [],
      weekPlanByChild: {},
      postsByChild: {},
      sharedPosts: [],
    });

    expect(candidates[0].validation).toEqual({
      state: 'rejected',
      reasons: ['missing_or_invalid_end'],
    });
  });

  test('deduplicates repeated refresh input with a stable fingerprint', () => {
    const event = {
      title: 'Cykeldag',
      start: '2026-09-22T08:00:00+02:00',
      end: '2026-09-22T13:00:00+02:00',
    };
    const input = {
      children: [{ name: 'Barn A', className: '3A' }],
      calendar: { 'Barn A': [event, { ...event }] },
      calendarInvitations: [],
      weekPlanByChild: {},
      postsByChild: {},
      sharedPosts: [],
    };

    const first = buildCalendarCandidates(input);
    const second = buildCalendarCandidates(input);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });
});
