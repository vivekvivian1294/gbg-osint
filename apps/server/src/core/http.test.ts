import { describe, expect, it, vi } from 'vitest';
import { UpstreamError, createHttpClient } from './http';

function client(fetchImpl: typeof fetch) {
  return createHttpClient({ allowedHosts: ['api.example.se'], userAgent: 'test', fetchImpl });
}

describe('createHttpClient', () => {
  it('fetches JSON from allow-listed hosts and sends a user agent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    await expect(client(fetchImpl).getJson('https://api.example.se/data')).resolves.toEqual({
      ok: true,
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('user-agent')).toBe('test');
  });

  it('blocks other hosts and plain HTTP', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl).getText('https://evil.example.com/')).rejects.toThrow(
      UpstreamError,
    );
    await expect(client(fetchImpl).getText('http://api.example.se/')).rejects.toThrow(
      UpstreamError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks redirects to hosts that are not allow-listed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
    );
    await expect(client(fetchImpl).getText('https://api.example.se/')).rejects.toThrow(
      /non-allow-listed host 169\.254\.169\.254/,
    );
  });

  it('follows redirects within the allow-list', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/v2' } }))
      .mockResolvedValueOnce(new Response('hello'));
    await expect(client(fetchImpl).getText('https://api.example.se/v1')).resolves.toBe('hello');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe('https://api.example.se/v2');
  });

  it('enforces the response size cap', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(2048)));
    await expect(
      client(fetchImpl).getText('https://api.example.se/', { maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it('reports HTTP errors without leaking the path or query', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 }));
    const err = await client(fetchImpl)
      .getText('https://api.example.se/secret?key=abc')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe('HTTP 503 from api.example.se');
    expect((err as UpstreamError).status).toBe(503);
  });

  it('posts a body and refuses to follow redirects for POST', async () => {
    const ok = vi.fn<typeof fetch>(async () => Response.json({ posted: true }));
    await expect(
      client(ok).postJson('https://api.example.se/q', '<REQUEST/>', {
        headers: { 'content-type': 'text/xml' },
      }),
    ).resolves.toEqual({ posted: true });
    const init = ok.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('<REQUEST/>');

    const redirect = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 307, headers: { location: '/elsewhere' } }),
    );
    await expect(client(redirect).postJson('https://api.example.se/q', 'x')).rejects.toThrow(
      'HTTP 307 from api.example.se',
    );
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
