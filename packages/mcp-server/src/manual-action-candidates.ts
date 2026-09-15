import { createHash } from 'node:crypto';

export interface ManualActionCandidate {
  sourceId: string;
  fingerprint: string;
  source: 'aula-message-thread' | 'aula-post';
  threadId?: number;
  postId?: number;
  subject: string | null;
  title: string;
  detail: string;
  actionType: 'response' | 'payment' | 'other';
  suggestedEvent: {
    title: string;
    start: null;
    end: null;
    location: null;
  };
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

function messageDetail(value: unknown): string {
  if (!Array.isArray(value)) return '';

  const messages = value.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const text = (message as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? [text.trim()] : [];
  });

  return (messages.at(-1) || '').slice(0, 360);
}

function attachmentText(value: unknown): string {
  if (!Array.isArray(value)) return '';

  return value
    .flatMap((attachment) => {
      if (!attachment || typeof attachment !== 'object') return [];
      const text = (attachment as Record<string, unknown>).text;
      return typeof text === 'string' && text.trim() ? [text.trim()] : [];
    })
    .join('\n')
    .slice(0, 360);
}

function actionType(value: string): ManualActionCandidate['actionType'] {
  if (/\b(betal|betaling|overfør|mobilepay|kr\.?\b)/i.test(value)) return 'payment';
  if (/\b(svar|tilmeld|bekræft|godkend|return[eé]r|underskriv|udfyld)/i.test(value)) {
    return 'response';
  }
  return 'other';
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
    const subject =
      typeof thread.subject === 'string' && thread.subject.trim().length > 0
        ? thread.subject.trim()
        : null;
    const title = subject || 'Aula-besked';
    const detail = messageDetail(thread.messages) || title;

    return [
      {
        sourceId,
        fingerprint: hash([sourceId]),
        source: 'aula-message-thread' as const,
        threadId,
        subject,
        title,
        detail,
        actionType: actionType(`${title}\n${detail}`),
        suggestedEvent: {
          title,
          start: null,
          end: null,
          location: null,
        },
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

export function buildPostManualActionCandidates(
  posts: Array<Record<string, unknown>>,
): ManualActionCandidate[] {
  return posts.flatMap((post) => {
    const postId = typeof post.id === 'number' ? post.id : Number(post.id);
    if (!Number.isFinite(postId) || postId < 1 || 'error' in post) return [];

    const sourceId = `post:${postId}`;
    const childSpecific =
      typeof post.appliesToChild === 'string' && post.appliesToChild.trim()
        ? [post.appliesToChild.trim()]
        : [];
    const appliesToChildren = childSpecific.length
      ? childSpecific
      : strings(post.appliesToChildren ?? post.children);
    const reasons = appliesToChildren.length > 0 ? [] : ['missing_child_binding'];
    const title =
      typeof post.title === 'string' && post.title.trim() ? post.title.trim() : 'Aula-opslag';
    const body = typeof post.text === 'string' && post.text.trim() ? post.text.trim() : '';
    const extracted = attachmentText(post.attachments);
    const detail = (body || extracted || title).slice(0, 360);

    return [{
      sourceId,
      fingerprint: hash([sourceId]),
      source: 'aula-post' as const,
      postId,
      subject: null,
      title,
      detail,
      actionType: actionType(`${title}\n${body}\n${extracted}`),
      suggestedEvent: { title, start: null, end: null, location: null },
      appliesToChildren,
      confidence: 'source_identity' as const,
      validation: {
        state: reasons.length === 0 ? ('valid' as const) : ('needs_child' as const),
        reasons,
      },
    }];
  });
}
