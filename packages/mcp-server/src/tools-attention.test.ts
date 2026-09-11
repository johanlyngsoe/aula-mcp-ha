import { describe, expect, test } from 'bun:test';
import { isPostActionText, isWeekPlanActionText } from './tools.ts';

describe('Aula attention filters', () => {
  test('keeps school photography from week plans', () => {
    expect(isWeekPlanActionText('Foto: 3.a skal fotograferes kl. 10.30.')).toBe(true);
  });

  test('keeps photography posts so their attachments can be read', () => {
    expect(isPostActionText('Fotografering uge 38')).toBe(true);
    expect(isPostActionText('Årets skoleportræt')).toBe(true);
  });

  test('still excludes ordinary non-actionable lesson text', () => {
    expect(isWeekPlanActionText('Matematik: Vi arbejder med gange.')).toBe(false);
  });
});
