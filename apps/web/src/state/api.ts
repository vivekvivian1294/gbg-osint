import type { z } from 'zod';

export async function fetchJson<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return schema.parse(await res.json());
}
