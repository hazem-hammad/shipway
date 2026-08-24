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
 */
export class FakeDnsClient implements DnsClient {
  readonly records = new Map<string, string>();

  private readonly ids = new Map<string, string>();
  private nextId = 1;

  async verifyToken(): Promise<boolean> {
    return true;
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
