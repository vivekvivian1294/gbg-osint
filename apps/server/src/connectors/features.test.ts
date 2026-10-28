import { decodeLine, FeatureSchema, type LonLat } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { parseWaterways } from './osm';
import { buildTrafficCorridors, onewayOf, sideBearing, type RoadWay } from './roadFlow';
import { corridorFeatures, parseFlowRecords, parseRoads } from './trafikverket';
import { fromLocalM, lineLengthM, simplifyLine, toLocalM } from './util';

/** Points `n` metres apart heading east from `start` (local metres). */
function eastward(start: [number, number], steps: number, stepM: number): LonLat[] {
  return Array.from({ length: steps + 1 }, (_, i) => fromLocalM([start[0] + i * stepM, start[1]]));
}

describe('line helpers', () => {
  it('converts to local metres and back', () => {
    const p: LonLat = [11.99, 57.72];
    const [lon, lat] = fromLocalM(toLocalM(p));
    expect(lon).toBeCloseTo(p[0], 9);
    expect(lat).toBeCloseTo(p[1], 9);
  });

  it('simplifies collinear points but keeps corners', () => {
    const straight = eastward([0, 0], 10, 20);
    expect(simplifyLine(straight, 1)).toHaveLength(2);
    const corner = [...straight, fromLocalM([200, 100])];
    expect(simplifyLine(corner, 1)).toHaveLength(3);
    expect(lineLengthM(straight)).toBeCloseTo(200, 0);
  });
});

describe('parseWaterways', () => {
  const geometry = (pts: LonLat[]) => pts.map(([lon, lat]) => ({ lon, lat }));
  const a = eastward([0, 0], 4, 50);
  const b = eastward([200, 0], 4, 50);

  it('joins continuing ways, keeps flow direction and drops tunnels and short bits', () => {
    const features = parseWaterways(
      {
        elements: [
          {
            type: 'way',
            id: 2,
            tags: { waterway: 'river', name: 'Säveån' },
            geometry: geometry(b),
          },
          {
            type: 'way',
            id: 1,
            tags: { waterway: 'river', name: 'Säveån' },
            geometry: geometry(a),
          },
          {
            type: 'way',
            id: 3,
            tags: { waterway: 'stream', tunnel: 'culvert' },
            geometry: geometry(eastward([0, 500], 4, 50)),
          },
          {
            type: 'way',
            id: 4,
            tags: { waterway: 'stream' },
            geometry: geometry(eastward([0, 900], 1, 20)),
          },
          { type: 'way', id: 5, tags: { waterway: 'ditch' }, geometry: geometry(a) },
        ],
      },
      Date.parse('2026-10-23T12:00:00Z'),
    );
    expect(features).toHaveLength(1);
    const [river] = features;
    expect(FeatureSchema.safeParse(river).success).toBe(true);
    expect(river).toMatchObject({ id: 'way/1', kind: 'waterway', label: 'Säveån' });
    expect(river!.props).toEqual({ class: 'river' });
    const line = decodeLine(river!.line);
    expect(lineLengthM(line)).toBeCloseTo(400, -1);
    expect(line[0]![0]).toBeLessThan(line.at(-1)![0]);
  });
});

describe('traffic flow', () => {
  it('maps measurement sides and oneway tags', () => {
    expect(sideBearing('southBound')).toBe(180);
    expect(sideBearing('unknown')).toBeUndefined();
    expect(onewayOf({ highway: 'motorway' })).toBe(1);
    expect(onewayOf({ highway: 'primary', oneway: '-1' })).toBe(-1);
    expect(onewayOf({ highway: 'primary' })).toBe(0);
    expect(onewayOf({ highway: 'secondary', junction: 'roundabout' })).toBe(1);
  });

  it('parses TrafficFlow records', () => {
    const records = parseFlowRecords([
      {
        SiteId: 7,
        MeasurementTime: '2026-10-23T15:22:00.000+02:00',
        MeasurementSide: 'eastBound',
        SpecificLane: 'lane2',
        VehicleFlowRate: 900,
        AverageVehicleSpeed: 72.5,
        Geometry: { WGS84: 'POINT (11.9 57.7)' },
      },
      { SiteId: 8, MeasurementTime: 'x', VehicleFlowRate: 1, Geometry: { WGS84: 'POINT (1 1)' } },
    ]);
    expect(records).toEqual([
      {
        siteId: 7,
        lon: 11.9,
        lat: 57.7,
        bearing: 90,
        lane: 'lane2',
        flowVehH: 900,
        speedKmh: 72.5,
        measuredAt: '2026-10-23T13:22:00.000Z',
      },
    ]);
  });

  it('parses Overpass road ways', () => {
    const ways = parseRoads({
      elements: [
        {
          type: 'way',
          id: 1,
          nodes: [1, 2],
          geometry: [
            { lon: 11.9, lat: 57.7 },
            { lon: 11.91, lat: 57.7 },
          ],
          tags: { highway: 'motorway', ref: 'E6' },
        },
        { type: 'way', id: 2, nodes: [1], geometry: [{ lon: 1, lat: 1 }], tags: {} },
      ],
    });
    expect(ways).toEqual([
      expect.objectContaining({ id: 1, highway: 'motorway', oneway: 1, ref: 'E6' }),
    ]);
  });

  // Dual carriageway heading east/west plus a continuation of the eastbound side.
  const east1: RoadWay = {
    id: 1,
    nodes: [1, 2, 3, 4, 5],
    coords: eastward([0, 0], 4, 100),
    highway: 'motorway',
    oneway: 1,
    ref: 'E20',
  };
  const east2: RoadWay = {
    id: 2,
    nodes: [5, 6, 7, 8, 9],
    coords: eastward([400, 0], 4, 100),
    highway: 'motorway',
    oneway: 1,
    ref: 'E20',
  };
  const west: RoadWay = {
    id: 3,
    nodes: [10, 11, 12, 13, 14, 15, 16, 17, 18],
    coords: eastward([800, 20], 8, -100),
    highway: 'motorway',
    oneway: 1,
    ref: 'E20',
  };
  const record = (x: number, y: number, side: number, lane: string, flow: number) => {
    const [lon, lat] = fromLocalM([x, y]);
    return {
      siteId: 42,
      lon,
      lat,
      bearing: side,
      lane,
      flowVehH: flow,
      speedKmh: 80,
      measuredAt: '2026-10-23T13:00:00.000Z',
    };
  };

  it('snaps lanes to the matching carriageway and extends along the road', () => {
    const corridors = buildTrafficCorridors(
      [east1, east2, west],
      [
        record(350, 3, 90, 'lane1', 600),
        record(350, 6, 90, 'lane2', 400),
        record(350, 17, 270, 'lane1', 500),
      ],
    );
    expect(corridors).toHaveLength(2);
    const eastbound = corridors.find((c) => c.flowVehH === 1000)!;
    expect(eastbound).toMatchObject({ lanes: 2, speedKmh: 80, twoWay: false, road: 'E20' });
    const [x0] = toLocalM(eastbound.coords[0]!);
    const [x1] = toLocalM(eastbound.coords.at(-1)!);
    expect(x0).toBeCloseTo(50, -1);
    expect(x1).toBeCloseTo(650, -1);

    const westbound = corridors.find((c) => c.flowVehH === 500)!;
    const [w0] = toLocalM(westbound.coords[0]!);
    expect(w0).toBeGreaterThan(toLocalM(westbound.coords.at(-1)!)[0]);
  });

  it('ignores records far from any road and builds valid features', () => {
    const corridors = buildTrafficCorridors([east1], [record(100, 500, 90, 'lane1', 300)]);
    expect(corridors).toEqual([]);
    const features = corridorFeatures(
      buildTrafficCorridors([east1, east2], [record(200, 2, 90, 'lane1', 300)]),
    );
    expect(features).toHaveLength(1);
    expect(FeatureSchema.safeParse(features[0]).success).toBe(true);
    expect(features[0]!.props).toMatchObject({ flowVehH: 300, lanes: 1 });
  });
});
