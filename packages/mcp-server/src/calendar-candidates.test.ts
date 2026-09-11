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
      now: new Date('2026-09-11T10:00:00+02:00'),
      children: [
        { name: 'Barn A', className: '3.a' },
        { name: 'Barn B', className: '1C' },
      ],
      calendar: {},
      calendarInvitations: [],
      weekPlanByChild: {
        'Barn A': [
          {
            resolvedDate: 'tirsdag 15. sep.',
            subject: 'Foto',
            content: 'Foto: 3.a skal fotograferes kl. 10.30.',
          },
        ],
        'Barn B': [
          {
            resolvedDate: 'onsdag 16. sep.',
            subject: 'Fotografering',
            content: 'Skolefoto: 1.c: 10.30 - 11.15',
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
                'Mandag 14/09/2026 Tirsdag 15/09/2026 Onsdag 16/09/2026',
                '3. lektion 10:30-11:15 Cirkel 2. lektion 10:00-10:30 7B',
                '3. lektion 10:30-11:15 1C',
                '4. lektion 11:50-12:30 8A 3. lektion 10:30-11:15 3A',
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
      now: new Date('2026-09-11T10:00:00+02:00'),
      children: [{ name: 'Barn A', className: '3A' }],
      calendar: {},
      calendarInvitations: [],
      weekPlanByChild: {
        'Barn A': [
          { resolvedDate: 'tirsdag 15. sep.', title: 'Fotografering' },
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
