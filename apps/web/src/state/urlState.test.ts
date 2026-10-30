import { describe, expect, it } from 'vitest';
import { parseHash, serializeHash } from './urlState';

describe('url state', () => {
  it('round-trips camera, basemap and layers', () => {
    const hash = serializeHash({
      camera: { lon: 11.97461234, lat: 57.70891234, height: 7000.4, heading: 12.34, pitch: -35 },
      basemap: 'dark',
      layers: ['police', 'aircraft'],
    });
    expect(hash).toBe('cam=11.97461,57.70891,7000,12.3,-35.0&map=dark&layers=police,aircraft');
    expect(parseHash(`#${hash}`)).toEqual({
      camera: { lon: 11.97461, lat: 57.70891, height: 7000, heading: 12.3, pitch: -35 },
      basemap: 'dark',
      layers: ['police', 'aircraft'],
    });
  });

  it('ignores invalid values', () => {
    expect(parseHash('#cam=999,57,7000,0,-35&map=evil&layers=ok,<script>,ok,Bad')).toEqual({
      layers: ['ok'],
    });
    expect(parseHash('#cam=1,2,3')).toEqual({});
    expect(parseHash('#cam=11,57,0,0,-35')).toEqual({});
    expect(parseHash('')).toEqual({});
  });

  it('distinguishes no layers parameter from an empty one', () => {
    expect(parseHash('#map=dark').layers).toBeUndefined();
    expect(parseHash('#layers=').layers).toEqual([]);
    expect(serializeHash({ layers: [] })).toBe('layers=');
  });

  it('normalises heading into 0–360', () => {
    expect(parseHash('#cam=11,57,1000,-90,-30').camera?.heading).toBe(270);
  });

  it('round-trips style, HUD, detection and a tracked target with unusual ids', () => {
    const state = {
      style: 'nvg' as const,
      hud: true,
      detection: true,
      track: { layerId: 'poi', id: 'node/123:x+y' },
    };
    const hash = serializeHash(state);
    expect(hash).toBe('style=nvg&hud=1&det=1&track=poi:node%2F123%3Ax%2By');
    expect(parseHash(`#${hash}`)).toEqual(state);
  });

  it('ignores invalid style and track values', () => {
    expect(parseHash('#style=evil&hud=yes&track=:abc')).toEqual({});
    expect(parseHash(`#track=aircraft:${'x'.repeat(129)}`)).toEqual({});
    expect(serializeHash({ style: 'normal' })).toBe('');
  });

  it('round-trips a replayed moment and ignores malformed ones', () => {
    expect(serializeHash({ time: 1793361946334.4 })).toBe('t=1793361946334');
    expect(parseHash('#t=1793361946334')).toEqual({ time: 1793361946334 });
    for (const bad of ['#t=', '#t=17933619463', '#t=1793361946334.5', '#t=-1793361946334']) {
      expect(parseHash(bad), bad).toEqual({});
    }
  });
});
