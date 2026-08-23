import { describe, expect, it } from 'vitest';
import { FakeDnsClient, makeCloudflareClient } from '../src/services/cloudflare.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

describe('FakeDnsClient', () => {
  it('verifyToken always resolves true', async () => {
    const client = new FakeDnsClient();
    await expect(client.verifyToken()).resolves.toBe(true);
  });

  it('createARecord stores the fqdn -> ip mapping in the public records map', async () => {
    const client = new FakeDnsClient();

    await client.createARecord('foo.apps.example.com', '10.0.0.1');

    expect(client.records.get('foo.apps.example.com')).toBe('10.0.0.1');
  });

  it('createARecord returns deterministic ids starting at fake-1', async () => {
    const client = new FakeDnsClient();

    const first = await client.createARecord('foo.apps.example.com', '10.0.0.1');
    const second = await client.createARecord('bar.apps.example.com', '10.0.0.2');

    expect(first).toBe('fake-1');
    expect(second).toBe('fake-2');
  });

  it('id counter is monotonic across creates and deletes, never reused', async () => {
    const client = new FakeDnsClient();

    const a = await client.createARecord('a.apps.example.com', '10.0.0.1');
    const b = await client.createARecord('b.apps.example.com', '10.0.0.2');
    await client.deleteARecord('a.apps.example.com');
    const c = await client.createARecord('c.apps.example.com', '10.0.0.3');

    expect([a, b, c]).toEqual(['fake-1', 'fake-2', 'fake-3']);
  });

  it('findARecord returns the id of a previously created record', async () => {
    const client = new FakeDnsClient();
    const id = await client.createARecord('foo.apps.example.com', '10.0.0.1');

    await expect(client.findARecord('foo.apps.example.com')).resolves.toBe(id);
  });

  it('findARecord returns null for an fqdn that was never created', async () => {
    const client = new FakeDnsClient();

    await expect(client.findARecord('missing.apps.example.com')).resolves.toBeNull();
  });

  it('deleteARecord removes the record from records and findARecord returns null after', async () => {
    const client = new FakeDnsClient();
    await client.createARecord('foo.apps.example.com', '10.0.0.1');

    await client.deleteARecord('foo.apps.example.com');

    expect(client.records.has('foo.apps.example.com')).toBe(false);
    await expect(client.findARecord('foo.apps.example.com')).resolves.toBeNull();
  });

  it('deleteARecord is a silent no-op for an fqdn that was never created', async () => {
    const client = new FakeDnsClient();

    await expect(client.deleteARecord('missing.apps.example.com')).resolves.toBeUndefined();
    expect(client.records.size).toBe(0);
  });

  it('createARecord overwrites the ip for an fqdn that already has a record', async () => {
    const client = new FakeDnsClient();
    await client.createARecord('foo.apps.example.com', '10.0.0.1');

    await client.createARecord('foo.apps.example.com', '10.0.0.2');

    expect(client.records.get('foo.apps.example.com')).toBe('10.0.0.2');
  });
});

interface StubFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StubResponse {
  status?: number;
  body: unknown;
}

function makeStubFetch(responses: StubResponse[]): { fetch: typeof fetch; calls: StubFetchCall[] } {
  const calls: StubFetchCall[] = [];
  let index = 0;

  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, headers, body });

    const next = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200 });
  }) as typeof fetch;

  return { fetch: stub, calls };
}

describe('makeCloudflareClient', () => {
  it('defaults to the global fetch when none is injected', () => {
    const client = makeCloudflareClient('test-token', 'zone-id');
    expect(typeof client.verifyToken).toBe('function');
  });

  it('verifyToken GETs /user/tokens/verify with Bearer auth and returns true on an active token', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      { body: { success: true, result: { id: 'tok', status: 'active' }, errors: [] } },
    ]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await expect(client.verifyToken()).resolves.toBe(true);

    expect(calls).toEqual([
      {
        url: `${CLOUDFLARE_API_BASE}/user/tokens/verify`,
        method: 'GET',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: undefined,
      },
    ]);
  });

  it('verifyToken returns false when the API reports success:false', async () => {
    const { fetch: stub } = makeStubFetch([{ body: { success: false, result: null, errors: [{ code: 1000, message: 'invalid' }] } }]);
    const client = makeCloudflareClient('bad-token', 'zone-id', stub);

    await expect(client.verifyToken()).resolves.toBe(false);
  });

  it('verifyToken returns false when the token status is not active', async () => {
    const { fetch: stub } = makeStubFetch([
      { body: { success: true, result: { id: 'tok', status: 'disabled' }, errors: [] } },
    ]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await expect(client.verifyToken()).resolves.toBe(false);
  });

  it('createARecord POSTs type A, name, content, ttl 300, proxied false and returns the created id', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      { body: { success: true, result: { id: 'rec-123', type: 'A', name: 'foo.apps.example.com', content: '10.0.0.1' }, errors: [] } },
    ]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    const id = await client.createARecord('foo.apps.example.com', '10.0.0.1');

    expect(id).toBe('rec-123');
    expect(calls).toEqual([
      {
        url: `${CLOUDFLARE_API_BASE}/zones/zone-id/dns_records`,
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: { type: 'A', name: 'foo.apps.example.com', content: '10.0.0.1', ttl: 300, proxied: false },
      },
    ]);
  });

  it('createARecord throws when the Cloudflare API reports failure', async () => {
    const { fetch: stub } = makeStubFetch([{ body: { success: false, result: null, errors: [{ code: 1004, message: 'nope' }] } }]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await expect(client.createARecord('foo.apps.example.com', '10.0.0.1')).rejects.toThrow();
  });

  it('findARecord GETs dns_records filtered by type A and name, returning the first id', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      {
        body: {
          success: true,
          result: [
            { id: 'rec-1', type: 'A', name: 'foo.apps.example.com', content: '10.0.0.1' },
            { id: 'rec-2', type: 'A', name: 'foo.apps.example.com', content: '10.0.0.1' },
          ],
          errors: [],
        },
      },
    ]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    const id = await client.findARecord('foo.apps.example.com');

    expect(id).toBe('rec-1');
    expect(calls).toEqual([
      {
        url: `${CLOUDFLARE_API_BASE}/zones/zone-id/dns_records?type=A&name=foo.apps.example.com`,
        method: 'GET',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: undefined,
      },
    ]);
  });

  it('findARecord returns null when the API returns an empty result list', async () => {
    const { fetch: stub } = makeStubFetch([{ body: { success: true, result: [], errors: [] } }]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await expect(client.findARecord('missing.apps.example.com')).resolves.toBeNull();
  });

  it('deleteARecord finds then DELETEs the record when present', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      { body: { success: true, result: [{ id: 'rec-1', type: 'A', name: 'foo.apps.example.com', content: '10.0.0.1' }], errors: [] } },
      { body: { success: true, result: { id: 'rec-1' }, errors: [] } },
    ]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await client.deleteARecord('foo.apps.example.com');

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      url: `${CLOUDFLARE_API_BASE}/zones/zone-id/dns_records/rec-1`,
      method: 'DELETE',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: undefined,
    });
  });

  it('deleteARecord is a silent no-op (no DELETE call) when the record is absent', async () => {
    const { fetch: stub, calls } = makeStubFetch([{ body: { success: true, result: [], errors: [] } }]);
    const client = makeCloudflareClient('test-token', 'zone-id', stub);

    await expect(client.deleteARecord('missing.apps.example.com')).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });
});
