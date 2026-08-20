/**
 * AulaClient — typed wrapper around `https://www.aula.dk/api/v{N}/`.
 *
 * Two upstream-issue bake-ins live here:
 *   - **API version probing (#246, #248, log in #311)**: the version constant
 *     drifts. We probe v{start..end} on first use and cache the answer. An
 *     `onApiVersionChanged` callback fires when the active version changes
 *     mid-session (e.g. server returns 410 and we bump).
 *   - **CSRF token from cookie (`Csrfp-Token`)**: lifted from the cookie jar
 *     and sent as `csrfp-token` header on POSTs. Aula returns 403 otherwise.
 */

import {
  AulaCookieJar,
  AulaHttpClient,
  type AulaTokens,
  type Logger,
  silentLogger,
} from '@aula-mcp/aula-auth';
import type {
  AulaEnvelope,
  CalendarEvent,
  DailyOverviewEntry,
  GetCalendarEventsArgs,
  MessageThread,
  ProfileContextData,
  ProfilesByLoginData,
  ThreadMessage,
  ThreadMessagesData,
  ThreadsData,
} from './aula-types.ts';
import { AulaApiError, AulaApiVersionError, AulaStepUpRequiredError } from './errors.ts';

export interface AulaClientOptions {
  /** Tokens issued by AulaLoginClient. The access token is added as a query
   *  parameter (Aula's API quirk — they don't accept Bearer headers). */
  tokens: AulaTokens;
  http?: AulaHttpClient;
  logger?: Logger;
  /** Default v22; the probe will bump if needed. */
  initialApiVersion?: number;
  /** Inclusive bound for probing. Default 50. */
  maxApiVersion?: number;
  /** Override the API host. */
  apiBaseHost?: string;
  /** Notified when the probe lands on a different version than expected. */
  onApiVersionChanged?: (from: number, to: number) => void;
}

const DEFAULT_API_BASE_HOST = 'https://www.aula.dk';

/**
 * Format a Date as Aula's posts-style timestamp:
 * `YYYY-MM-DDTHH:MM:SS.0000+ZZZZ` in Europe/Copenhagen wall-clock time.
 *
 * `posts.getAllPosts` 400s on standard ISO (`.000Z`). The Aula web client
 * (and the reverse-engineered scaarup/aula Python client) use a `T`
 * separator + `.0000` + Copenhagen offset for the `index` cursor. Calendar
 * uses a space separator instead; the two endpoints disagree on this.
 */
function formatAulaTimestamp(d: Date, separator: 'T' | ' ' = 'T'): string {
  const fmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hourPart = get('hour') === '24' ? '00' : get('hour');
  const cphHour = Number(hourPart);
  const utcHour = d.getUTCHours();
  let offsetH = cphHour - utcHour;
  if (offsetH > 12) offsetH -= 24;
  if (offsetH < -12) offsetH += 24;
  const sign = offsetH >= 0 ? '+' : '-';
  const hh = String(Math.abs(offsetH)).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}${separator}${hourPart}:${get('minute')}:${get('second')}.0000${sign}${hh}00`;
}

export class AulaClient {
  readonly http: AulaHttpClient;
  private readonly logger: Logger;
  private tokens: AulaTokens;
  private apiVersion: number;
  private readonly maxApiVersion: number;
  private readonly apiBaseHost: string;
  private readonly onVersionChanged?: (from: number, to: number) => void;
  private versionVerified = false;

  constructor(options: AulaClientOptions) {
    this.tokens = options.tokens;
    this.logger = options.logger ?? silentLogger;
    this.http = options.http ?? new AulaHttpClient({ logger: this.logger });
    this.apiVersion = options.initialApiVersion ?? 22;
    this.maxApiVersion = options.maxApiVersion ?? 50;
    this.apiBaseHost = options.apiBaseHost ?? DEFAULT_API_BASE_HOST;
    if (options.onApiVersionChanged) this.onVersionChanged = options.onApiVersionChanged;
  }

  /** Update tokens after a refresh. */
  setTokens(tokens: AulaTokens): void {
    this.tokens = tokens;
  }

  /** Currently-active API version. Useful for diagnostics. */
  get currentApiVersion(): number {
    return this.apiVersion;
  }

  // --- Probing --------------------------------------------------------------

  /**
   * Probe the API to find a working version. Lazily called by every API
   * method on first invocation, but exposed publicly so callers can do it
   * eagerly (e.g. before a batch of requests).
   */
  async ensureApiVersion(): Promise<number> {
    if (this.versionVerified) return this.apiVersion;
    const tried: number[] = [];
    for (let v = this.apiVersion; v <= this.maxApiVersion; v++) {
      tried.push(v);
      const url = this.apiUrl(v, { method: 'profiles.getProfilesByLogin' });
      const res = await this.http.request(url, { method: 'GET' });
      // 200 → working; 410 → bump; anything else stops probing.
      if (res.status === 200) {
        if (v !== this.apiVersion) {
          const from = this.apiVersion;
          this.apiVersion = v;
          this.logger.info('aula.api.version_changed', { from, to: v });
          this.onVersionChanged?.(from, v);
        }
        this.versionVerified = true;
        return v;
      }
      if (res.status === 410) {
        this.logger.warn('aula.api.version_gone', { version: v });
        continue;
      }
      throw new AulaApiError(
        `Unexpected status ${res.status} probing API version ${v}`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    throw new AulaApiVersionError(
      `Could not find a working API version in v${this.apiVersion}..v${this.maxApiVersion}`,
      tried,
    );
  }

  // --- Methods --------------------------------------------------------------

  async getProfilesByLogin(): Promise<ProfilesByLoginData> {
    return this.getJson<ProfilesByLoginData>('profiles.getProfilesByLogin');
  }

  async getProfileContext(role: 'guardian' | 'employee' = 'guardian'): Promise<ProfileContextData> {
    return this.getJson<ProfileContextData>('profiles.getProfileContext', { portalrole: role });
  }

  async getDailyOverview(childIds: readonly number[]): Promise<DailyOverviewEntry[]> {
    if (childIds.length === 0) return [];
    const params = new URLSearchParams();
    params.set('method', 'presence.getDailyOverview');
    for (const id of childIds) params.append('childIds[]', String(id));
    const data = await this.getJsonRaw<DailyOverviewEntry[]>(params);
    return data ?? [];
  }

  async getCalendarEvents(args: GetCalendarEventsArgs): Promise<CalendarEvent[]> {
    const body = JSON.stringify({
      instProfileIds: args.profileIds,
      resourceIds: args.resourceIds ?? [],
      start: args.start,
      end: args.end,
    });
    return (
      (await this.postJson<CalendarEvent[]>(
        'calendar.getEventsByProfileIdsAndResourceIds',
        body,
      )) ?? []
    );
  }

  async getThreads(opts: { page?: number; pageSize?: number } = {}): Promise<MessageThread[]> {
    const params: Record<string, string> = {
      sortOn: 'date',
      orderDirection: 'desc',
      page: String(opts.page ?? 0),
    };
    if (opts.pageSize) params.pageSize = String(opts.pageSize);
    const data = await this.getJson<ThreadsData>('messaging.getThreads', params);
    return data.threads ?? [];
  }

  /**
   * Fetch a single thread's messages. Throws AulaStepUpRequiredError when the
   * thread is sensitive and Aula returns status.code 403 — the user must
   * MitID step-up to read it.
   */
  async getMessagesForThread(
    threadId: number,
    opts: { page?: number } = {},
  ): Promise<{
    subject?: string;
    messages: ThreadMessage[];
    recipients?: unknown[];
  }> {
    const url = this.apiUrl(this.apiVersion, {
      method: 'messaging.getMessagesForThread',
      threadId: String(threadId),
      page: String(opts.page ?? 0),
    });
    const res = await this.http.request(url, { method: 'GET' });
    if (res.status !== 200) {
      throw new AulaApiError(
        `getMessagesForThread failed (status ${res.status})`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    const env = JSON.parse(res.body) as AulaEnvelope<ThreadMessagesData>;
    if (env.status?.code === 403) {
      throw new AulaStepUpRequiredError(
        env.status.message ??
          'Thread requires MitID step-up; ask the user to refresh their session.',
      );
    }
    if (env.status?.code && env.status.code !== 0) {
      throw new AulaApiError(
        `getMessagesForThread error code ${env.status.code}: ${env.status.message ?? '<unknown>'}`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    const data: ThreadMessagesData = env.data ?? { messages: [] };
    const rawData =
      env.data && typeof env.data === 'object'
        ? (env.data as unknown as Record<string, unknown>)
        : {};

    return {
      ...(data.subject ? { subject: data.subject } : {}),
      messages: data.messages ?? [],
      ...(Array.isArray(rawData.recipients)
        ? { recipients: rawData.recipients }
        : {}),
    };
  }

  /**
   * `notifications.getNotificationsForActiveProfile` — what's unread.
   * Returns the raw `data` field; agents can format the shape they need.
   */
  async getNotifications(): Promise<unknown> {
    return this.getJson<unknown>('notifications.getNotificationsForActiveProfile');
  }

  /**
   * `posts.getAllPosts` — class-level news feed (teacher posts, etc.).
   *
   * In v23 Aula's API has two distinct scoping modes:
   *
   * 1. `parent: 'profile'` + `institutionProfileIds[]` — returns only the
   *    guardian's UNREAD posts since `profileLastSeenPostDate`. Each call
   *    advances the cursor to "now", so subsequent calls return empty.
   *    `institutionProfileIds` are the GUARDIAN's institutionProfile.id per
   *    school (from `profilesByLogin.profiles[0].institutionProfiles[*].id`).
   *
   * 2. `parent: 'group'` + `groupId` (SINGLE) — returns the group's full
   *    feed including already-read posts. The Aula iPhone app uses this
   *    mode and iterates through every group the guardian has access to.
   *    Group IDs come from `profileContext.institutions[].groups[].id` and
   *    `profileContext.municipalGroups[].id`.
   *
   *    NOTE: the array form `groupIds[]` does NOT work — only the singular
   *    `groupId` param. So a multi-group view requires one request per group.
   *
   * `index` may be a numeric postId cursor — Aula accepts numerics and
   * rejects date strings (HTTP 400, status.code=40) in v23. Most callers
   * should omit it for the first page.
   *
   * Returns the raw `data` field.
   */
  async getPosts(
    opts:
      | {
          institutionProfileIds: readonly number[];
          groupId?: never;
          parent?: 'profile' | string;
          limit?: number;
          index?: string;
          direction?: string;
        }
      | {
          groupId: number;
          institutionProfileIds?: never;
          parent?: 'group' | string;
          limit?: number;
          index?: string;
          direction?: string;
        },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('method', 'posts.getAllPosts');
    if ('groupId' in opts && opts.groupId !== undefined) {
      params.set('parent', opts.parent ?? 'group');
      params.set('groupId', String(opts.groupId));
    } else if ('institutionProfileIds' in opts && opts.institutionProfileIds !== undefined) {
      if (opts.institutionProfileIds.length === 0) {
        throw new Error('getPosts: institutionProfileIds must be non-empty');
      }
      params.set('parent', opts.parent ?? 'profile');
      for (const id of opts.institutionProfileIds) {
        params.append('institutionProfileIds[]', String(id));
      }
    } else {
      throw new Error('getPosts: must pass either institutionProfileIds or groupId');
    }
    if (opts.index !== undefined) params.set('index', opts.index);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.direction !== undefined) params.set('direction', opts.direction);
    const data = await this.getJsonRaw<unknown>(params);
    if (data === undefined) {
      throw new AulaApiError('posts.getAllPosts response missing data', 200, '', '');
    }
    return data;
  }

  /**
   * Generic escape hatch for endpoints we haven't typed wrappers for.
   * The MCP server gates this behind AULA_MCP_RAW=1.
   *
   * @param method     Aula API method name (e.g. 'profiles.getProfilesByLogin')
   * @param params     Extra query-string params (access_token + method are added)
   * @param body       JSON body for POST requests; pass undefined for GET
   */
  async rawRequest(
    method: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    if (body !== undefined) {
      return this.postJson<unknown>(method, JSON.stringify(body));
    }
    return this.getJson<unknown>(method, params);
  }

  /**
   * Get a token for a third-party widget (Min Uddannelse / EasyIQ / Meebook
   * / Systematic). Used by the WidgetTokenManager (next package layer).
   */
  async getWidgetToken(widgetId: string): Promise<string> {
    const data = await this.getJsonRaw<string>(
      new URLSearchParams({ method: 'aulaToken.getAulaToken', widgetId }),
    );
    if (!data) throw new AulaApiError('aulaToken response missing data', 200, '', '');
    return data;
  }

  /** Generic GET that returns the parsed `data` field of the envelope. */
  async getJson<T>(method: string, query: Record<string, string> = {}): Promise<T> {
    const params = new URLSearchParams({ method, ...query });
    const data = await this.getJsonRaw<T>(params);
    if (data === undefined) {
      throw new AulaApiError(`${method} response missing data field`, 200, '', '');
    }
    return data;
  }

  /** GET with a manually-built params object (allows array fields like `childIds[]`). */
  async getJsonRaw<T>(params: URLSearchParams): Promise<T | undefined> {
    const version = await this.ensureApiVersion();
    params.set('access_token', this.tokens.access_token);
    const url = `${this.apiBaseHost}/api/v${version}/?${params.toString()}`;
    const res = await this.http.request(url, { method: 'GET' });
    return this.parseEnvelope<T>(res.url, res.status, res.body, params);
  }

  /** POST JSON body to an Aula API method. Sets CSRF header from cookie jar. */
  async postJson<T>(method: string, body: string): Promise<T | undefined> {
    const version = await this.ensureApiVersion();
    const params = new URLSearchParams({ method });
    params.set('access_token', this.tokens.access_token);
    const url = `${this.apiBaseHost}/api/v${version}/?${params.toString()}`;
    const csrf = await this.http.jar.getCookieValue(url, 'Csrfp-Token');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (csrf) headers['csrfp-token'] = csrf;
    const res = await this.http.request(url, { method: 'POST', headers, body });
    return this.parseEnvelope<T>(res.url, res.status, res.body, params);
  }

  /**
   * Probe-aware envelope parser. On 410, retries once after re-probing the
   * version (#246/#248 mid-session bumps).
   */
  private async parseEnvelope<T>(
    url: string,
    status: number,
    body: string,
    paramsForRetry: URLSearchParams,
  ): Promise<T | undefined> {
    if (status === 410 && this.versionVerified) {
      // Mid-session bump.
      this.versionVerified = false;
      this.apiVersion += 1;
      this.logger.warn('aula.api.version_410', { newProbeFrom: this.apiVersion });
      const newVersion = await this.ensureApiVersion();
      paramsForRetry.set('access_token', this.tokens.access_token);
      const retryUrl = `${this.apiBaseHost}/api/v${newVersion}/?${paramsForRetry.toString()}`;
      const res = await this.http.request(retryUrl, { method: 'GET' });
      return this.parseEnvelope<T>(res.url, res.status, res.body, paramsForRetry);
    }
    if (status !== 200) {
      throw new AulaApiError(`API returned status ${status}`, status, url, body.slice(0, 300));
    }
    const env = JSON.parse(body) as AulaEnvelope<T>;
    if (env.status?.code && env.status.code !== 0) {
      throw new AulaApiError(
        `API error code ${env.status.code}: ${env.status.message ?? '<unknown>'}`,
        status,
        url,
        body.slice(0, 300),
      );
    }
    return env.data;
  }

  private apiUrl(version: number, params: Record<string, string>): string {
    const qs = new URLSearchParams(params);
    qs.set('access_token', this.tokens.access_token);
    return `${this.apiBaseHost}/api/v${version}/?${qs.toString()}`;
  }
}

// Avoid unused-import lint when using AulaCookieJar transitively.
void AulaCookieJar;
