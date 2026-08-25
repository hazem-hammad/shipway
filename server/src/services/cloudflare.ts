/**
 * Thin seam over Cloudflare DNS so the provisioner can create/find/delete
 * the A record for a deployed project's subdomain without knowing whether
 * it's talking to the real API or a test double.
 *
 * The `cloudflare` npm package is a project dependency, but
 * `makeCloudflareClient` talks to the REST API directly via an injectable
 * `fetch` instead of the SDK client: this keeps the real implementation
 * fully unit-testable (exact URL/method/headers/body assertions) without
 * any network access or mocking the SDK's internals.
 */
export interface DnsClient {
  /** Checks that the configured API token is valid and active. */
  verifyToken(): Promise<boolean>;
  /** Creates an A record for `fqdn` pointing at `ip` (ttl 300, proxied false). Returns the record id. */
  createARecord(fqdn: string, ip: string): Promise<string>;
  /** Finds the A record for `fqdn`. Returns its id, or `null` if none exists. */
  findARecord(fqdn: string): Promise<string | null>;
  /** Deletes the A record for `fqdn`, if any. Silent no-op when absent. */
  deleteARecord(fqdn: string): Promise<void>;
}

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * True when a stored Cloudflare credential (`cloudflare_token`/`cloudflare_zone_id`) is missing,
 * empty, or whitespace-only. Shared by `app.ts`'s `dns()` getter and `routes/cloudflare.ts`'s
 * verify route so "is Cloudflare configured" is judged identically everywhere instead of two
 * truthiness checks silently drifting apart (plan Task 1 / spec §3 "Cloudflare verify").
 */
export function isBlankCredential(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

interface CloudflareError {
  code: number;
  message: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors: CloudflareError[];
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

interface TokenVerifyResult {
  id: string;
  status: string;
}

/**
 * Real `DnsClient`, backed by the Cloudflare REST API. `fetchImpl` defaults
 * to the global `fetch`; tests inject a stub to assert exact request shape
 * without hitting the network.
 */
class CloudflareDnsClient implements DnsClient {
  constructor(
    private readonly token: string,
    private readonly zoneId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async cfFetch<T>(path: string, init: RequestInit = {}): Promise<CloudflareEnvelope<T>> {
    const response = await this.fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    return (await response.json()) as CloudflareEnvelope<T>;
  }

  async verifyToken(): Promise<boolean> {
    const body = await this.cfFetch<TokenVerifyResult>('/user/tokens/verify', { method: 'GET' });
    return body.success === true && body.result?.status === 'active';
  }

  async createARecord(fqdn: string, ip: string): Promise<string> {
    const body = await this.cfFetch<DnsRecord>(`/zones/${this.zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'A', name: fqdn, content: ip, ttl: 300, proxied: false }),
    });
    if (!body.success) {
      throw new Error(`Cloudflare createARecord failed for ${fqdn}: ${JSON.stringify(body.errors)}`);
    }
    return body.result.id;
  }

  async findARecord(fqdn: string): Promise<string | null> {
    const query = new URLSearchParams({ type: 'A', name: fqdn }).toString();
    const body = await this.cfFetch<DnsRecord[]>(`/zones/${this.zoneId}/dns_records?${query}`, { method: 'GET' });
    if (!body.success) {
      throw new Error(`Cloudflare findARecord failed for ${fqdn}: ${JSON.stringify(body.errors)}`);
    }
    return body.result[0]?.id ?? null;
  }

  async deleteARecord(fqdn: string): Promise<void> {
    const id = await this.findARecord(fqdn);
    if (id === null) {
      return;
    }
    const body = await this.cfFetch<{ id: string }>(`/zones/${this.zoneId}/dns_records/${id}`, { method: 'DELETE' });
    if (!body.success) {
      throw new Error(`Cloudflare deleteARecord failed for ${fqdn}: ${JSON.stringify(body.errors)}`);
    }
  }
}

/**
 * Builds the real `DnsClient`, backed by the Cloudflare REST API for
 * `zoneId` using `token` for Bearer auth. `fetchImpl` is an optional
 * injection point for tests; production callers should omit it.
 */
export function makeCloudflareClient(token: string, zoneId: string, fetchImpl: typeof fetch = fetch): DnsClient {
  return new CloudflareDnsClient(token, zoneId, fetchImpl);
}

/**
 * In-memory `DnsClient` double for tests and dev mode. `records` (fqdn ->
 * ip) is public so tests can assert on it directly; ids are deterministic
 * (`fake-<n>`), assigned in creation order and never reused.
 *
 * `createARecord`/`findARecord`/`deleteARecord` stay fully in-memory unconditionally, so dev-mode
 * project provisioning keeps working fully offline regardless of whether real Cloudflare
 * credentials are configured. `verifyToken()` is the one exception (plan Task 1 / spec §3
 * "Cloudflare verify"): dev mode must not fake success just because it's dev mode. It reads
 * whatever credentials `setCredentials()` was last called with (the `dns()` getter in `app.ts`
 * calls it fresh on every request from the current stored settings) — with none set it resolves
 * `false`, and with credentials set it delegates to a REAL `CloudflareDnsClient` for an honest
 * network round-trip, so a wrong/placeholder token pasted in dev mode fails exactly like it would
 * in production instead of always reporting "Connected".
 */
export class FakeDnsClient implements DnsClient {
  readonly records = new Map<string, string>();

  private readonly ids = new Map<string, string>();
  private nextId = 1;
  private credentials: { token: string; zoneId: string } | null = null;

  /**
   * `fetchImpl` is an injection point for tests (mirrors `makeCloudflareClient`'s own parameter),
   * so `verifyToken()`'s real API call can be exercised with a stub instead of the network.
   * Production (dev-mode `app.ts`) omits it and gets the real global `fetch`.
   */
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Sets (or clears, via `null`) the credentials `verifyToken()` uses — see the class doc comment. */
  setCredentials(credentials: { token: string; zoneId: string } | null): void {
    this.credentials = credentials;
  }

  async verifyToken(): Promise<boolean> {
    if (!this.credentials) return false;
    return makeCloudflareClient(this.credentials.token, this.credentials.zoneId, this.fetchImpl).verifyToken();
  }

  async createARecord(fqdn: string, ip: string): Promise<string> {
    this.records.set(fqdn, ip);
    const id = `fake-${String(this.nextId)}`;
    this.nextId += 1;
    this.ids.set(fqdn, id);
    return id;
  }

  async findARecord(fqdn: string): Promise<string | null> {
    return this.ids.get(fqdn) ?? null;
  }

  async deleteARecord(fqdn: string): Promise<void> {
    this.records.delete(fqdn);
    this.ids.delete(fqdn);
  }
}
