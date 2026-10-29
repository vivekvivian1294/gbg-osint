import { describe, expect, it } from 'vitest';
import {
  distanceToGeometryM,
  flatDistanceM,
  geometryVertices,
  pointInPolygon,
  pointInRing,
  type LonLat,
} from './geo';

const square: LonLat[] = [
  [11.9, 57.7],
  [12.0, 57.7],
  [12.0, 57.8],
  [11.9, 57.8],
];
const hole: LonLat[] = [
  [11.94, 57.74],
  [11.96, 57.74],
  [11.96, 57.76],
  [11.94, 57.76],
];

describe('geometry helpers', () => {
  it('tests points against rings and polygons with holes', () => {
    expect(pointInRing([11.95, 57.75], square)).toBe(true);
    expect(pointInRing([12.05, 57.75], square)).toBe(false);
    expect(pointInPolygon([11.95, 57.75], [square, hole])).toBe(false);
    expect(pointInPolygon([11.91, 57.71], [square, hole])).toBe(true);
    expect(pointInPolygon([11.91, 57.71], [])).toBe(false);
  });

  it('measures distance to points, lines and polygons', () => {
    const p: LonLat = [11.95, 57.7];
    // 0.01° of latitude is about 1,105 m.
    expect(flatDistanceM(p, [11.95, 57.71])).toBeCloseTo(1105, -1);
    expect(
      distanceToGeometryM(p, {
        type: 'LineString',
        coordinates: [
          [11.9, 57.71],
          [12.0, 57.71],
        ],
      }),
    ).toBeCloseTo(1105, -1);
    expect(distanceToGeometryM([11.95, 57.75], { type: 'Polygon', coordinates: [square] })).toBe(0);
    expect(
      distanceToGeometryM([11.95, 57.69], { type: 'Polygon', coordinates: [square] }),
    ).toBeCloseTo(1105, -1);
    expect(distanceToGeometryM(p, { type: 'Point', coordinates: ['bad'] })).toBe(Infinity);
  });

  it('lists the vertices of any geometry type', () => {
    expect(
      geometryVertices({
        type: 'MultiLineString',
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
          [[5, 6]],
        ],
      }),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(geometryVertices({ type: 'MultiPolygon', coordinates: [[square]] })).toHaveLength(4);
    expect(geometryVertices({ type: 'GeometryCollection', coordinates: [] })).toEqual([]);
  });
});
