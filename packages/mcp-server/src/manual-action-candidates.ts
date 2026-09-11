import { createHash } from 'node:crypto';

export interface ManualActionCandidate {
  sourceId: string;
  fingerprint: string;
  source: 'aula-message-thread';
  threadId: number;
  subject: string | null;
  appliesToChildren: string[];
  confidence: 'source_identity';
  validation: {
    state: 'valid' | 'needs_child';
    reasons: string[];
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b, 'da-DK'));
}

export function buildManualActionCandidates(
  threads: Array<Record<string, unknown>>,
): ManualActionCandidate[] {
  return threads.flatMap((thread) => {
    const threadId =
      typeof thread.threadId === 'number' ? thread.threadId : Number(thread.threadId);

    if (!Number.isFinite(threadId) || threadId < 1 || 'error' in thread) {
      return [];
    }

    const sourceId = `message-thread:${threadId}`;
    const appliesToChildren = strings(thread.appliesToChildren);
    const reasons = appliesToChildren.length > 0 ? [] : ['missing_child_binding'];

    return [
      {
        sourceId,
        fingerprint: hash([sourceId]),
        source: 'aula-message-thread' as const,
        threadId,
        subject:
          typeof thread.subject === 'string' && thread.subject.trim().length > 0
            ? thread.subject.trim()
            : null,
        appliesToChildren,
        confidence: 'source_identity' as const,
        validation: {
          state: reasons.length === 0 ? ('valid' as const) : ('needs_child' as const),
          reasons,
        },
      },
    ];
  });
}
