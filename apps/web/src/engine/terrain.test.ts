import type { CesiumWidget } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { distinctPoints } from './draped';
import { GEOID_M, Ground } from './terrain';

function fakeGlobe(height: number | undefined) {
  const getHeight = vi.fn(() => height);
  const globe = { scene: { globe: { getHeight } } } as unknown as CesiumWidget;
  return { globe, getHeight };
}

describe('ground heights', () => {
  it('leaves heights alone on the plain ellipsoid', () => {
    const { globe, getHeight } = fakeGlobe(80);
    const ground = new Ground(globe);
    expect(ground.surface(11.97, 57.7)).toBe(0);
    expect(ground.heightOf(11.97, 57.7, 0)).toBe(0);
    expect(ground.heightOf(11.97, 57.7, 1200)).toBe(1200);
    expect(getHeight).not.toHaveBeenCalled();
  });

  it('puts ground objects on the terrain and aircraft above sea level', () => {
    const { globe } = fakeGlobe(80);
    const ground = new Ground(globe);
    ground.terrain = true;
    expect(ground.heightOf(11.97, 57.7, 0)).toBe(80);
    expect(ground.heightOf(11.97, 57.7, 1200)).toBe(1200 + GEOID_M);
  });

  it('caches surface heights per cell until refreshed', () => {
    const { globe, getHeight } = fakeGlobe(80);
    const ground = new Ground(globe);
    ground.terrain = true;
    ground.surface(11.97, 57.7);
    ground.surface(11.97001, 57.70001);
    expect(getHeight).toHaveBeenCalledTimes(1);

    expect(ground.refresh(10_000)).toBe(true);
    expect(ground.refresh(10_500)).toBe(false);
    expect(ground.version).toBe(1);
    ground.surface(11.97, 57.7);
    expect(getHeight).toHaveBeenCalledTimes(2);
  });

  it('falls back to sea level where no tile has loaded, and asks again later', () => {
    const { globe, getHeight } = fakeGlobe(undefined);
    const ground = new Ground(globe);
    ground.terrain = true;
    expect(ground.surface(11.97, 57.7)).toBe(GEOID_M);
    ground.surface(11.97, 57.7);
    expect(getHeight).toHaveBeenCalledTimes(2);
  });
});

describe('draped lines', () => {
  it('drops repeated points and the closing point of a loop', () => {
    const ring: [number, number][] = [
      [11.9, 57.7],
      [11.9, 57.7],
      [12, 57.7],
      [12, 57.8],
      [11.9, 57.7],
    ];
    expect(distinctPoints(ring)).toEqual([
      [11.9, 57.7],
      [12, 57.7],
      [12, 57.8],
      [11.9, 57.7],
    ]);
    expect(distinctPoints(ring, true)).toEqual([
      [11.9, 57.7],
      [12, 57.7],
      [12, 57.8],
    ]);
  });
});
