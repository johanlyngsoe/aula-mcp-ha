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

const ATTACHMENT_ACTION_PATTERN =
  /(forældrene?\s+skal|\bI\s+skal\b|barnet\s+skal|eleverne?\s+skal|skal\s+(?:hjælpe|forberede|øve|medbringe|have\s+med|sende|svare|betale|tilmelde)|hjælp(?:e)?\s+.+\s+med\s+at|forbered(?:e|else)|øv(?:e|else)|medbring|husk\s+at|tilmeld|betaling|betal|deadline|frist|svar\s+(?:senest|inden)|udfyld|underskriv)/i;

function contextWindow(text: string, index: number, length = 96): string {
  if (text.length <= length) return text.trim();

  const half = Math.floor(length / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(text.length, start + length);
  start = Math.max(0, end - length);

  const before = text.lastIndexOf('\n', start);
  if (before >= 0 && index - before <= half + 24) start = before + 1;

  const after = text.indexOf('\n', end);
  if (after >= 0 && after - index <= half + 24) end = after;

  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function firstTermIndex(text: string, terms: string[]): number {
  const normalized = text.toLocaleLowerCase('da-DK');
  const indexes = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

export function attachmentText(value: unknown, priorityTerms: string[] = []): string {
  if (!Array.isArray(value)) return '';

  const terms = [
    ...new Set(
      priorityTerms.flatMap((term) => {
        const normalized = term.trim().toLocaleLowerCase('da-DK');
        if (!normalized) return [];
        return [normalized, ...normalized.split(/\s+/).filter((part) => part.length >= 3)];
      }),
    ),
  ];

  const texts = value.flatMap((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') return [];
    const text = (attachment as Record<string, unknown>).text;
    if (typeof text !== 'string' || !text.trim()) return [];
    return [{ text: text.trim(), index }];
  });

  const childContexts = texts.flatMap(({ text, index }) => {
    const matchIndex = firstTermIndex(text, terms);
    return matchIndex >= 0
      ? [{ text: contextWindow(text, matchIndex), index }]
      : [];
  });

  const actionContexts = texts.flatMap(({ text, index }) => {
    const match = ATTACHMENT_ACTION_PATTERN.exec(text);
    return match
      ? [{ text: contextWindow(text, match.index), index }]
      : [];
  });

  const selected = [...childContexts, ...actionContexts]
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text)
    .filter((text, index, all) => all.indexOf(text) === index);

  if (selected.length === 0) {
    const fallback = texts.at(0)?.text || '';
    return fallback.slice(0, 180);
  }

  const child = childContexts.at(0)?.text;
  const action = actionContexts.find(({ text }) => text !== child)?.text;
  const contexts = [child, action].filter((text): text is string => Boolean(text));

  if (contexts.length === 1 && selected.length > 1) {
    contexts.push(selected.find((text) => text !== contexts[0]) || '');
  }

  return contexts.filter(Boolean).join('\n').slice(0, 220);
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
    const extracted = attachmentText(post.attachments, appliesToChildren);
    const detailParts = [body.slice(0, 139), extracted].filter(Boolean);
    const detail = (detailParts.join('\n') || title).slice(0, 360);

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
