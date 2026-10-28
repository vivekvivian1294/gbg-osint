import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Cached<T> {
  value: T;
  savedAt: number;
}

/** Small per-connector JSON cache so restarts don't re-download data that changes rarely. */
export interface ConnectorCache {
  get<T>(key: string, maxAgeMs: number): Promise<Cached<T> | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const KEY = /^[a-z0-9_-]{1,64}$/;

export function createDiskCache(dir: string, namespace: string, now = Date.now): ConnectorCache {
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error(`Invalid cache key: ${key}`);
    return join(dir, `${namespace.replace(/[^a-z0-9_.-]/gi, '_')}--${key}.json`);
  };

  return {
    async get<T>(key: string, maxAgeMs: number) {
      try {
        const raw = JSON.parse(await readFile(file(key), 'utf8')) as Partial<Cached<T>>;
        if (typeof raw.savedAt !== 'number' || now() - raw.savedAt > maxAgeMs) return undefined;
        return { value: raw.value as T, savedAt: raw.savedAt };
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      const target = file(key);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: now(), value }));
      await rename(tmp, target);
    },
  };
}
