/** Error whose message is safe to show to clients: it never contains URLs, paths or keys. */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpClient {
  getText(url: string, options?: RequestOptions): Promise<string>;
  getBytes(url: string, options?: RequestOptions): Promise<Buffer>;
  getJson(url: string, options?: RequestOptions): Promise<unknown>;
  /** POST without following redirects. */
  postJson(url: string, body: string, options?: RequestOptions): Promise<unknown>;
}

export interface HttpClientOptions {
  allowedHosts: readonly string[];
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * HTTP client for connectors. Only HTTPS requests to the connector's allow-listed hosts are
 * permitted (including redirect targets), with a timeout and a response size cap.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const fetchImpl = options.fetchImpl ?? fetch;

  function assertAllowed(raw: string | URL): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UpstreamError('Invalid upstream URL');
    }
    if (url.protocol !== 'https:')
      throw new UpstreamError(`Blocked non-HTTPS request to ${url.host}`);
    if (!allowed.has(url.hostname.toLowerCase())) {
      throw new UpstreamError(`Blocked request to non-allow-listed host ${url.hostname}`);
    }
    return url;
  }

  async function request(
    raw: string,
    opts: RequestOptions,
    body?: string,
  ): Promise<{ res: Response; host: string }> {
    let url = assertAllowed(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const signals = [AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
      if (options.signal) signals.push(options.signal);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'user-agent': options.userAgent, ...opts.headers },
          ...(body !== undefined && { body }),
          redirect: 'manual',
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.name : 'Error';
        throw new UpstreamError(`Request to ${url.host} failed (${reason})`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && body === undefined) {
        await res.body?.cancel();
        url = assertAllowed(new URL(location, url));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new UpstreamError(`HTTP ${res.status} from ${url.host}`, res.status);
      }
      return { res, host: url.host };
    }
    throw new UpstreamError(`Too many redirects from ${url.host}`);
  }

  async function readCapped(res: Response, host: string, maxBytes: number): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw new UpstreamError(`Response from ${host} exceeds ${maxBytes} bytes`);
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpstreamError(`Response from ${host} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function getBytes(url: string, opts: RequestOptions = {}): Promise<Buffer> {
    const { res, host } = await request(url, opts);
    return readCapped(res, host, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  async function getText(url: string, opts: RequestOptions = {}): Promise<string> {
    return (await getBytes(url, opts)).toString('utf8');
  }

  function parseJson(text: string, url: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError(`Invalid JSON from ${new URL(url).host}`);
    }
  }

  return {
    getText,
    getBytes,
    async getJson(url, opts = {}) {
      const text = await getText(url, {
        ...opts,
        headers: { accept: 'application/json', ...opts.headers },
      });
      return parseJson(text, url);
    },
    async postJson(url, body, opts = {}) {
      const { res, host } = await request(
        url,
        { ...opts, headers: { accept: 'application/json', ...opts.headers } },
        body,
      );
      const bytes = await readCapped(res, host, opts.maxBytes ?? DEFAULT_MAX_BYTES);
      return parseJson(bytes.toString('utf8'), url);
    },
  };
}
