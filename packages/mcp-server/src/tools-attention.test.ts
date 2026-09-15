import { describe, expect, test } from 'bun:test';
import {
  hasExpiredExplicitDanishEventDate,
  isPostActionCandidate,
  isPostActionText,
  isPostManualActionCandidate,
  isWeekPlanActionText,
} from './tools.ts';

describe('Aula attention filters', () => {
  test('keeps school photography from week plans', () => {
    expect(isWeekPlanActionText('Foto: 3.a skal fotograferes kl. 10.30.')).toBe(true);
  });

  test('keeps photography posts so their attachments can be read', () => {
    expect(isPostActionText('Fotografering uge 38')).toBe(true);
    expect(isPostActionText('Årets skoleportræt')).toBe(true);
  });

  test('keeps a post with readable attachment text even when title/body do not match keywords', () => {
    expect(
      isPostActionCandidate({
        title: 'Ugens Professor',
        text: 'Kære forældre. Se de vedhæftede dokumenter.',
        attachments: [
          {
            name: 'Ugens Professor 3.a endeligt dokument.docx',
            readable: true,
            text: 'Uge 48 Mikkeline',
          },
        ],
      }),
    ).toBe(true);
  });

  test('treats Ugens Professor as a manual family action', () => {
    expect(
      isPostManualActionCandidate({
        title: 'Ugens Professor',
        text: 'Forældrene skal hjælpe barnet med at forberede sin præsentation.',
        attachments: [
          {
            name: 'Ugens Professor 3.a endeligt dokument.docx',
            text: '48  Mikkeline',
          },
        ],
      }),
    ).toBe(true);
  });

  test('does not turn an informational post into a manual action just because it has a readable attachment', () => {
    expect(
      isPostManualActionCandidate({
        title: 'Nyt fra skolen',
        text: 'Her er information om den kommende periode.',
        attachments: [
          {
            name: 'information.pdf',
            text: 'Praktisk information om skolen og årets aktiviteter.',
          },
        ],
      }),
    ).toBe(false);
  });

  test('does not keep a plain post without action text or extracted attachment text', () => {
    expect(
      isPostActionCandidate({
        title: 'Nyt fra klassen',
        text: 'Tak for en god uge.',
        attachments: [],
      }),
    ).toBe(false);
  });

  test('still excludes ordinary non-actionable lesson text', () => {
    expect(isWeekPlanActionText('Matematik: Vi arbejder med gange.')).toBe(false);
  });

  test('expires a message subject with a passed numeric event date', () => {
    const now = new Date('2026-09-11T10:00:00+02:00');

    expect(
      hasExpiredExplicitDanishEventDate(
        'Mille og Freyas fødselsdag, lørdag d. 29/8 kl. 10.30',
        now,
      ),
    ).toBe(true);
  });

  test('expires a passed Danish date range', () => {
    const now = new Date('2026-09-11T10:00:00+02:00');

    expect(
      hasExpiredExplicitDanishEventDate(
        'Lejrskole d. 9.-10. september',
        now,
      ),
    ).toBe(true);
  });

  test('keeps future and same-day event dates', () => {
    const now = new Date('2026-09-11T10:00:00+02:00');

    expect(
      hasExpiredExplicitDanishEventDate('Fotografering d. 15/9', now),
    ).toBe(false);
    expect(
      hasExpiredExplicitDanishEventDate('Arrangement 11. september 2026', now),
    ).toBe(false);
  });

  test('keeps a yearless January date when evaluated in December', () => {
    const now = new Date('2026-12-20T10:00:00+01:00');

    expect(
      hasExpiredExplicitDanishEventDate('Fødselsdag d. 10/1', now),
    ).toBe(false);
  });

  test('does not expire subjects without a parseable event date', () => {
    expect(
      hasExpiredExplicitDanishEventDate(
        'Svar på invitation',
        new Date('2026-09-11T10:00:00+02:00'),
      ),
    ).toBe(false);
  });
});