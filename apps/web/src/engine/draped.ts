import type { LonLat } from '@gbg-osint/shared';
import {
  Cartesian3,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineColorAppearance,
  PolylineMaterialAppearance,
  type Material,
} from 'cesium';

/** Lines and areas draped on whatever surface is drawn: the plain ellipsoid or real terrain. */

export interface DrapedLine {
  coords: readonly LonLat[];
  width: number;
  color?: Color;
  /** Pick id, e.g. a PickRef. */
  id?: unknown;
  /** Join the last point back to the first. */
  loop?: boolean;
}

const positions = (coords: readonly LonLat[]) =>
  Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));

const same = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/**
 * Ground polylines fail on zero-length segments ("normalized result is not a number"), so repeated
 * points are dropped, and the closing point of a ring that is drawn as a loop.
 */
export function distinctPoints(coords: readonly LonLat[], loop = false): LonLat[] {
  const out: LonLat[] = [];
  for (const p of coords) if (!out.length || !same(out.at(-1)!, p)) out.push(p);
  if (loop && out.length > 1 && same(out[0]!, out.at(-1)!)) out.pop();
  return out;
}

function lineInstance(line: DrapedLine): GeometryInstance {
  return new GeometryInstance({
    geometry: new GroundPolylineGeometry({
      positions: positions(line.coords),
      width: line.width,
      ...(line.loop && { loop: true }),
    }),
    ...(line.id !== undefined && { id: line.id }),
    ...(line.color && {
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(line.color) },
    }),
  });
}

const validLines = (lines: readonly DrapedLine[]): DrapedLine[] =>
  lines
    .map((l) => ({ ...l, coords: distinctPoints(l.coords, l.loop) }))
    .filter((l) => l.coords.length >= (l.loop ? 3 : 2));

/** Lines in their own colours (`color` on every line). */
export function drapedLines(
  lines: readonly DrapedLine[],
  pickable = true,
): GroundPolylinePrimitive | undefined {
  const valid = validLines(lines);
  if (valid.length === 0) return undefined;
  return new GroundPolylinePrimitive({
    geometryInstances: valid.map(lineInstance),
    appearance: new PolylineColorAppearance(),
    allowPicking: pickable,
    classificationType: ClassificationType.TERRAIN,
  });
}

/** Lines sharing one material, e.g. an animated or outlined one. */
export function drapedMaterialLines(
  lines: readonly DrapedLine[],
  material: Material,
  pickable = true,
): GroundPolylinePrimitive | undefined {
  const valid = validLines(lines);
  if (valid.length === 0) return undefined;
  return new GroundPolylinePrimitive({
    geometryInstances: valid.map(lineInstance),
    appearance: new PolylineMaterialAppearance({ material, translucent: true }),
    allowPicking: pickable,
    classificationType: ClassificationType.TERRAIN,
  });
}

export interface DrapedArea {
  /** `[outer, ...holes]`. */
  rings: readonly (readonly LonLat[])[];
  color: Color;
  id?: unknown;
}

/** Filled polygons on the surface. */
export function drapedAreas(
  areas: readonly DrapedArea[],
  pickable = true,
): GroundPrimitive | undefined {
  const instances = areas.flatMap((a) => {
    const [outer, ...holes] = a.rings;
    if (!outer || outer.length < 3) return [];
    return [
      new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(
            positions(outer),
            holes.map((h) => new PolygonHierarchy(positions(h))),
          ),
          vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(a.color) },
        ...(a.id !== undefined && { id: a.id }),
      }),
    ];
  });
  if (instances.length === 0) return undefined;
  return new GroundPrimitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
    allowPicking: pickable,
    classificationType: ClassificationType.TERRAIN,
  });
}

/** True while any of the primitives is still building its geometry (needs more renders). */
export function building(...primitives: readonly ({ ready: boolean } | undefined)[]): boolean {
  return primitives.some((p) => p !== undefined && !p.ready);
}
