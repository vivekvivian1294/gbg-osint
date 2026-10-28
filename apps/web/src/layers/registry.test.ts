import type { SourceStatus } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { LAYERS, layerAvailability, type LayerDef } from './registry';

const layer: LayerDef = {
  id: 'x',
  label: 'X',
  group: 'events',
  sourceIds: ['a', 'b'],
  channels: ['events.x'],
  phase: 1,
};

function source(id: string, overrides: Partial<SourceStatus> = {}): SourceStatus {
  return {
    id,
    name: id,
    mode: 'poll',
    licence: 'CC0',
    state: 'ok',
    consecutiveFailures: 0,
    channels: [],
    missingEnv: [],
    ...overrides,
  };
}

describe('layerAvailability', () => {
  it('is planned until every source exists on the server', () => {
    expect(layerAvailability(layer, new Map([['a', source('a')]]))).toEqual({
      kind: 'planned',
      phase: 1,
    });
  });

  it('needs configuration when a source is disabled', () => {
    const sources = new Map([
      ['a', source('a')],
      ['b', source('b', { state: 'disabled', missingEnv: ['B_KEY'] })],
    ]);
    expect(layerAvailability(layer, sources)).toEqual({ kind: 'needs-config', missing: ['B_KEY'] });
  });

  it('reports the worst source state when available', () => {
    const sources = new Map([
      ['a', source('a')],
      ['b', source('b', { state: 'degraded' })],
    ]);
    expect(layerAvailability(layer, sources)).toEqual({ kind: 'available', state: 'degraded' });
  });
});

describe('LAYERS', () => {
  it('has unique, URL-safe ids', () => {
    const ids = LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});
