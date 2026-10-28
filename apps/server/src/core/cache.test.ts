import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiskCache } from './cache';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('createDiskCache', () => {
  it('stores values and honours max age', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gbg-cache-'));
    let now = 1000;
    const cache = createDiskCache(dir, 'celestrak.satellites', () => now);
    expect(await cache.get('elements', 60_000)).toBeUndefined();

    await cache.set('elements', [{ a: 1 }]);
    expect(await cache.get('elements', 60_000)).toEqual({ value: [{ a: 1 }], savedAt: 1000 });

    now = 1000 + 60_001;
    expect(await cache.get('elements', 60_000)).toBeUndefined();
  });

  it('rejects unsafe keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gbg-cache-'));
    const cache = createDiskCache(dir, 'x');
    await expect(cache.set('../evil', 1)).rejects.toThrow(/Invalid cache key/);
  });
});
