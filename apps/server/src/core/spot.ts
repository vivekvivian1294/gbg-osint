import {
  decodeLine,
  distanceToGeometryM,
  flatDistanceM,
  isArea,
  isEntity,
  isEvent,
  pointInPolygon,
  type Area,
  type LonLat,
  type SpotReport,
} from '@gbg-osint/shared';
import type { ChannelStore } from './store';

const DISTRICTS = 'context.districts';
const CAMERAS = 'cameras.road';
const EVENT_RADIUS_M = 500;
const CAMERA_RADIUS_M = 5_000;
const MAX_EVENTS = 20;
const MAX_CAMERAS = 3;
/** Police events are placed at best in a named district; "within 500 m" would be meaningless. */
const PRECISE = new Set(['exact', 'area']);

const decoded = new WeakMap<Area, LonLat[][][]>();
function polygonsOf(area: Area): LonLat[][][] {
  let polygons = decoded.get(area);
  if (!polygons) {
    polygons = area.polygons.map((rings) => rings.map(decodeLine));
    decoded.set(area, polygons);
  }
  return polygons;
}

/** District, nearby events and the nearest road cameras for a point. */
export function spotReport(store: ChannelStore, lon: number, lat: number): SpotReport {
  const p: LonLat = [lon, lat];
  const items = (channel: string) => (store.has(channel) ? store.snapshot(channel) : []);

  const area = items(DISTRICTS)
    .filter(isArea)
    .find((a) => polygonsOf(a).some((rings) => pointInPolygon(p, rings)));

  const events = store
    .list()
    .filter((c) => c.kind === 'events')
    .flatMap(({ name }) =>
      items(name)
        .filter(isEvent)
        .flatMap((event) =>
          event.geometry && PRECISE.has(event.locationPrecision)
            ? [{ channel: name, event, distanceM: distanceToGeometryM(p, event.geometry) }]
            : [],
        ),
    )
    .filter((e) => e.distanceM <= EVENT_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_EVENTS);

  const cameras = items(CAMERAS)
    .filter(isEntity)
    .map((entity) => ({
      channel: CAMERAS,
      entity,
      distanceM: flatDistanceM(p, [entity.lon, entity.lat]),
    }))
    .filter((c) => c.distanceM <= CAMERA_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_CAMERAS);

  const round = (m: number) => Math.round(m);
  return {
    lon,
    lat,
    ...(area && {
      district: {
        channel: DISTRICTS,
        id: area.id,
        label: area.label,
        ...(area.props && { props: area.props }),
      },
    }),
    events: events.map((e) => ({ ...e, distanceM: round(e.distanceM) })),
    cameras: cameras.map((c) => ({ ...c, distanceM: round(c.distanceM) })),
  };
}
