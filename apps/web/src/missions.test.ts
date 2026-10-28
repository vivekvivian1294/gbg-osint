import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from './config';
import { LAYER_BY_ID } from './layers/registry';
import { MISSIONS } from './missions';

describe('MISSIONS', () => {
  it('only use known layers and styles', () => {
    for (const m of MISSIONS) {
      for (const id of m.layers) expect(LAYER_BY_ID.has(id), `${m.id}: ${id}`).toBe(true);
      expect(STYLE_IDS).toContain(m.style);
    }
  });

  it('have unique ids', () => {
    expect(new Set(MISSIONS.map((m) => m.id)).size).toBe(MISSIONS.length);
  });
});
