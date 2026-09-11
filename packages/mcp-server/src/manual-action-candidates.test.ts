import { describe, expect, test } from 'bun:test';
import { buildManualActionCandidates } from './manual-action-candidates.ts';

describe('buildManualActionCandidates', () => {
  test('adds stable source identity without interpreting message semantics', () => {
    const thread = {
      threadId: 1234,
      subject: 'Betaling til lejrskole',
      appliesToChildren: ['Barn A'],
      messages: [{ sendDateTime: '2026-09-11T12:00:00+02:00', text: 'Test' }],
    };

    const first = buildManualActionCandidates([thread]);
    const second = buildManualActionCandidates([
      {
        ...thread,
        messages: [
          ...thread.messages,
          { sendDateTime: '2026-09-12T12:00:00+02:00', text: 'Reminder' },
        ],
      },
    ]);

    expect(first).toHaveLength(1);
    const firstCandidate = first[0];
    const secondCandidate = second[0];
    if (!firstCandidate || !secondCandidate) throw new Error('missing candidate');

    expect(firstCandidate).toMatchObject({
      sourceId: 'message-thread:1234',
      source: 'aula-message-thread',
      threadId: 1234,
      title: 'Betaling til lejrskole',
      detail: 'Test',
      actionType: 'payment',
      suggestedEvent: {
        title: 'Betaling til lejrskole',
        start: null,
        end: null,
        location: null,
      },
      appliesToChildren: ['Barn A'],
      confidence: 'source_identity',
      validation: { state: 'valid', reasons: [] },
    });
    expect(firstCandidate.fingerprint).toHaveLength(24);
    expect(secondCandidate.fingerprint).toBe(firstCandidate.fingerprint);
    expect(secondCandidate.detail).toBe('Test\n\nReminder');
  });

  test('keeps ambiguous child binding visible for explicit user choice', () => {
    const [candidate] = buildManualActionCandidates([
      { threadId: 99, subject: 'Betaling', messages: [] },
    ]);
    if (!candidate) throw new Error('missing candidate');

    expect(candidate.validation).toEqual({
      state: 'needs_child',
      reasons: ['missing_child_binding'],
    });
    expect(candidate.appliesToChildren).toEqual([]);
  });

  test('ignores invalid and failed thread records', () => {
    expect(
      buildManualActionCandidates([
        { threadId: 'nope', subject: 'Invitation' },
        { threadId: 12, error: 'step_up_required' },
      ]),
    ).toEqual([]);
  });
});
