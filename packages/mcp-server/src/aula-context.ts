/**
 * Lazy AulaClient + WidgetTokenManager that the MCP tools share. Tokens are
 * loaded on first use and refreshed transparently.
 *
 * The MCP server is deliberately stateless across restarts: it always reads
 * the same EncryptedFileTokenStore that the CLI writes to. This means
 * `aula login` from the terminal "just works" with any running server.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AulaHttpClient,
  EncryptedFileTokenStore,
  isTokenExpired,
  KeychainTokenStore,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  withFreshTokens,
} from '@aula-mcp/aula-auth';
import {
  AulaClient,
  EasyIqClient,
  EasyIqLektierClient,
  EasyIqSkoleportalClient,
  MeebookClient,
  MinUddannelseClient,
  SystematicClient,
  WidgetTokenManager,
} from '@aula-mcp/aula-client';

export interface AulaContextOptions {
  store?: TokenStore;
  logger?: Logger;
}

export class AulaContext {
  private readonly store: TokenStore;
  private readonly logger: Logger;
  private readonly http: AulaHttpClient;
  // Fields below are declared as `T | undefined` (not just `T?`) so we can
  // explicitly assign `undefined` to invalidate the cache (the strict
  // `exactOptionalPropertyTypes` flag forbids `field = undefined` on `T?`).
  private clientPromise: Promise<AulaClient> | undefined;
  private widgetManagerPromise: Promise<WidgetTokenManager> | undefined;
  private cachedRecord: StoredTokenRecord | undefined;
  /** Guardian user-id from getProfileContext. Used as the
   *  sessionId/sessionUUID/sessionuuid parameter by the third-party
   *  integrations. Stored as string — Aula returns either a numeric id
   *  or an opaque alphanumeric token; we treat it as opaque to match
   *  upstream Python's `str(child["userId"])` handling. */
  private cachedGuardianUserId: string | undefined;
  /** Guardian's institutionProfile.id per school, from
   *  profiles.getProfilesByLogin → profiles[0].institutionProfiles[*].id.
   *  Required as the `institutionProfileIds[]` scope on posts.getAllPosts;
   *  distinct from children[].institutionProfile.id. */
  private cachedInstitutionProfileIds: readonly number[] | undefined;
  /** Group IDs the guardian has access to, across institutions + municipal
   *  groups. posts.getAllPosts only returns the full feed (read + unread)
   *  when scoped with `parent=group&groupId=<N>`. Cached after first lookup. */
  private cachedGroupIds: readonly number[] | undefined;
  /** Map of groupId → metadata (institutionCode, institutionName, group
   *  name). Lets `aula_posts_list` attribute each post to a school so the
   *  LLM can place posts under the right child. */
  private cachedGroupMeta:
    | ReadonlyMap<number, { institutionCode?: string; institutionName?: string; name?: string }>
    | undefined;

  constructor(options: AulaContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.http = new AulaHttpClient({ logger: this.logger });
  }

  /**
   * Get the AulaClient, refreshing tokens if expired.
   *
   * Concurrency-safe (J5 fix): the in-flight `clientPromise` is shared across
   * concurrent callers, so a refresh fires once and everyone waits on it.
   *
   * Auto-recovery (Q8): if the cached tokens have expired since the client
   * was built, we drop the cached promise and rebuild — which re-reads the
   * token store from disk. This means a fresh `aula login` from the CLI
   * recovers a server with bad tokens without restarting the server process.
   */
  async getClient(): Promise<AulaClient> {
    if (this.cachedRecord && isTokenExpired(this.cachedRecord.tokens, 60)) {
      this.logger.info('aula-context.token_expired_invalidating');
      this.clientPromise = undefined;
    }
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient().catch((err: unknown) => {
        // On failure, clear the cached promise so the next call retries
        // rather than re-throwing the same stale rejection forever.
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  /** Drop all cached state. Useful for tests; also called when an upstream
   *  401/403 indicates the server's view of our tokens is wrong. */
  invalidate(): void {
    this.clientPromise = undefined;
    this.widgetManagerPromise = undefined;
    this.cachedRecord = undefined;
    this.cachedGuardianUserId = undefined;
    this.cachedInstitutionProfileIds = undefined;
    this.cachedGroupIds = undefined;
    this.cachedGroupMeta = undefined;
  }

  /**
   * Guardian user-id (from `profiles.getProfileContext.data.userId`).
   * Required as the `sessionId` / `sessionUUID` / `sessionuuid` parameter for
   * EasyIQ, Min Uddannelse, and Meebook. Cached after the first call.
   *
   * Per Python `client.py:670/757` — the integration calls fail without it.
   * Aula returns this as either a number or an opaque alphanumeric token;
   * we coerce to string and pass through verbatim.
   */
  async getGuardianUserId(): Promise<string> {
    if (this.cachedGuardianUserId !== undefined) return this.cachedGuardianUserId;
    const client = await this.getClient();
    const ctx = await client.getProfileContext('guardian');
    if (ctx.userId == null || ctx.userId === '') {
      throw new Error('profiles.getProfileContext returned no userId');
    }
    this.cachedGuardianUserId = String(ctx.userId);
    return this.cachedGuardianUserId;
  }

  /**
   * Guardian institutionProfile IDs (one per school), from
   * `profiles.getProfilesByLogin → profiles[0].institutionProfiles[*].id`.
   * Required as the `institutionProfileIds[]` scope on `posts.getAllPosts`.
   *
   * Distinct from `children[].institutionProfile.id` — those are the children's
   * profiles at their institutions; this is the guardian's profile at each
   * institution they're registered at. Cached after first call.
   */
  async getInstitutionProfileIds(): Promise<readonly number[]> {
    if (this.cachedInstitutionProfileIds !== undefined) return this.cachedInstitutionProfileIds;
    const client = await this.getClient();
    const data = await client.getProfilesByLogin();
    const seen = new Set<number>();
    const ids: number[] = [];
    for (const profile of data.profiles ?? []) {
      for (const ip of profile.institutionProfiles ?? []) {
        if (typeof ip.id === 'number' && !seen.has(ip.id)) {
          seen.add(ip.id);
          ids.push(ip.id);
        }
      }
    }
    this.cachedInstitutionProfileIds = ids;
    return ids;
  }

  /**
   * Group IDs the guardian has access to (across institutions + municipal
   * groups), discovered from `profiles.getProfileContext`. Required for the
   * full-history mode of `posts.getAllPosts` (`parent=group&groupId=<N>`),
   * which is the only way to fetch already-read posts.
   */
  async getGroupIds(): Promise<readonly number[]> {
    await this.ensureGroupCaches();
    return this.cachedGroupIds ?? [];
  }

  /** Lookup metadata for a group id (institutionCode, institutionName, group name). */
  async getGroupMeta(): Promise<
    ReadonlyMap<number, { institutionCode?: string; institutionName?: string; name?: string }>
  > {
    await this.ensureGroupCaches();
    return this.cachedGroupMeta ?? new Map();
  }

  /** Populate both `cachedGroupIds` and `cachedGroupMeta` from a single
   *  `getProfileContext` call. */
  private async ensureGroupCaches(): Promise<void> {
    if (this.cachedGroupIds !== undefined && this.cachedGroupMeta !== undefined) return;
    const client = await this.getClient();
    const ctx = (await client.getProfileContext('guardian')) as unknown as {
      institutions?: Array<{
        institutionCode?: string;
        institutionName?: string;
        groups?: Array<{ id?: number; name?: string }>;
      }>;
      municipalGroups?: Array<{
        id?: number;
        name?: string;
        membershipInstitutions?: string[];
      }>;
    };
    const seen = new Set<number>();
    const ids: number[] = [];
    const meta = new Map<
      number,
      { institutionCode?: string; institutionName?: string; name?: string }
    >();
    for (const inst of ctx.institutions ?? []) {
      for (const g of inst.groups ?? []) {
        if (typeof g.id === 'number' && !seen.has(g.id)) {
          seen.add(g.id);
          ids.push(g.id);
          const entry: { institutionCode?: string; institutionName?: string; name?: string } = {};
          if (inst.institutionCode) entry.institutionCode = inst.institutionCode;
          if (inst.institutionName) entry.institutionName = inst.institutionName;
          if (g.name) entry.name = g.name;
          meta.set(g.id, entry);
        }
      }
    }
    for (const g of ctx.municipalGroups ?? []) {
      if (typeof g.id === 'number' && !seen.has(g.id)) {
        seen.add(g.id);
        ids.push(g.id);
        const entry: { institutionCode?: string; institutionName?: string; name?: string } = {};
        // Municipal groups cover multiple institutions — take the first as a
        // best-effort attribution. If a guardian has overlap, both kids see
        // the same municipal post anyway.
        if (g.membershipInstitutions?.[0]) entry.institutionCode = g.membershipInstitutions[0];
        if (g.name) entry.name = g.name;
        meta.set(g.id, entry);
      }
    }
    this.cachedGroupIds = ids;
    this.cachedGroupMeta = meta;
  }

  async getWidgetManager(): Promise<WidgetTokenManager> {
    if (!this.widgetManagerPromise) {
      this.widgetManagerPromise = (async () =>
        new WidgetTokenManager({ client: await this.getClient() }))();
    }
    return this.widgetManagerPromise;
  }

  async getEasyIq(): Promise<EasyIqClient> {
    return new EasyIqClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getEasyIqSkoleportal(): Promise<EasyIqSkoleportalClient> {
    return new EasyIqSkoleportalClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getEasyIqLektier(): Promise<EasyIqLektierClient> {
    return new EasyIqLektierClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getMeebook(): Promise<MeebookClient> {
    return new MeebookClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getMinUddannelse(): Promise<MinUddannelseClient> {
    return new MinUddannelseClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getSystematic(): Promise<SystematicClient> {
    return new SystematicClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  /** The currently-loaded record (after first getClient()). */
  get record(): StoredTokenRecord | undefined {
    return this.cachedRecord;
  }

  private async buildClient(): Promise<AulaClient> {
    const record = await withFreshTokens({
      store: this.store,
      http: this.http,
      logger: this.logger,
    });
    this.cachedRecord = record;
    const client = new AulaClient({ tokens: record.tokens, http: this.http, logger: this.logger });
    // Establish the guardian session context so messaging/calendar endpoints
    // work on the first tool call. Aula's messaging API returns 403 when
    // getProfileContext has not been called yet in the current HTTP session.
    try {
      const ctx = await client.getProfileContext('guardian');
      if (this.cachedGuardianUserId === undefined && ctx.userId != null && ctx.userId !== '') {
        this.cachedGuardianUserId = String(ctx.userId);
      }
    } catch (err) {
      this.logger.warn('aula-context.session_warmup_failed', {
        error: (err as Error).message,
      });
    }
    return client;
  }
}

/**
 * Mirror the CLI's backend selection (apps/cli/src/store.ts) so the server
 * reads from the same place `aula login` writes to:
 *   1. AULA_MCP_NO_KEYCHAIN=1 → file backend regardless of platform.
 *   2. macOS + `security` available → KeychainTokenStore.
 *   3. Everything else → EncryptedFileTokenStore at AULA_MCP_DIR.
 */
function defaultStore(): TokenStore {
  if (KeychainTokenStore.isSupported() && process.env.AULA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainTokenStore();
  }
  const dir = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}
