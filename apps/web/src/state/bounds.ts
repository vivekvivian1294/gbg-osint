import {
  decodeLine,
  geometryVertices,
  isArea,
  isEntity,
  isEvent,
  isFeature,
  isMetric,
  type ChannelItem,
  type LonLat,
} from '@gbg-osint/shared';

/** The part of the globe in view, in degrees; `west > east` when it spans the antimeridian. */
export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type Box = [west: number, south: number, east: number, north: number];

export function boxOf(points: Iterable<LonLat>): Box | null {
  let box: Box | null = null;
  for (const [lon, lat] of points) {
    if (!box) box = [lon, lat, lon, lat];
    else {
      box[0] = Math.min(box[0], lon);
      box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon);
      box[3] = Math.max(box[3], lat);
    }
  }
  return box;
}

export function overlaps(box: Box, view: ViewBounds): boolean {
  if (box[1] > view.north || box[3] < view.south) return false;
  if (view.west <= view.east) return box[0] <= view.east && box[2] >= view.west;
  return box[2] >= view.west || box[0] <= view.east;
}

const boxes = new WeakMap<ChannelItem, Box | null>();

function* placeOf(item: ChannelItem): Generator<LonLat> {
  if (isEntity(item)) yield [item.lon, item.lat];
  else if (isEvent(item)) {
    if (item.geometry) yield* geometryVertices(item.geometry);
  } else if (isFeature(item)) yield* decodeLine(item.line);
  else if (isArea(item)) for (const polygon of item.polygons) yield* decodeLine(polygon[0] ?? '');
  else if (isMetric(item) && item.lon !== undefined && item.lat !== undefined) {
    yield [item.lon, item.lat];
  }
}

/** The extent of an item's place on the map, or null if it has none (news, departures, ...). */
export function itemBox(item: ChannelItem): Box | null {
  let box = boxes.get(item);
  if (box === undefined) {
    box = boxOf(placeOf(item));
    boxes.set(item, box);
  }
  return box;
}

export function inView(item: ChannelItem, view: ViewBounds): boolean {
  const box = itemBox(item);
  return box !== null && overlaps(box, view);
}
