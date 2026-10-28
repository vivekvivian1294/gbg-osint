import { BuildingTileSchema, type BuildingTile } from '@gbg-osint/shared';
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  Credit,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  type CreditDisplay,
  type Scene,
} from 'cesium';
import { fetchJson } from '../state/api';
import { lonLatOfTile, tilesAround, type TileRef } from './tiles';

const ZOOM = 14;
/** Above this camera height buildings are too small to matter; tiles are dropped. */
const MAX_CAMERA_HEIGHT_M = 12_000;
const MIN_RADIUS_M = 1_500;
const MAX_RADIUS_M = 4_500;
const MAX_TILES = 36;
const MAX_CACHED_TILES = 120;
const CONCURRENCY = 4;
const TILE_URL = '/api/data/openfreemap.buildings';
const CREDIT = new Credit('OpenFreeMap © OpenMapTiles © OpenStreetMap contributors', true);

const STOPS: readonly [number, Color][] = [
  [4, Color.fromCssColorString('#a8a29e')],
  [15, Color.fromCssColorString('#b9bec7')],
  [40, Color.fromCssColorString('#cbd3de')],
  [90, Color.fromCssColorString('#dde6f2')],
];

/** Low buildings warm stone, high-rises cool and light. */
export function buildingColor(height: number): Color {
  let prev = STOPS[0]!;
  if (height <= prev[0]) return prev[1];
  for (const stop of STOPS.slice(1)) {
    if (height <= stop[0]) {
      return Color.lerp(prev[1], stop[1], (height - prev[0]) / (stop[0] - prev[0]), new Color());
    }
    prev = stop;
  }
  return prev[1];
}

function primitiveFor(tile: BuildingTile): Primitive | undefined {
  const toPositions = (ring: readonly number[]) => {
    const degrees: number[] = [];
    for (let i = 0; i + 1 < ring.length; i += 2) {
      degrees.push(
        ...lonLatOfTile(
          tile.x + ring[i]! / tile.extent,
          tile.y + ring[i + 1]! / tile.extent,
          tile.z,
        ),
      );
    }
    return Cartesian3.fromDegreesArray(degrees);
  };
  const instances: GeometryInstance[] = [];
  for (const [height, minHeight, polygons] of tile.buildings) {
    const color = ColorGeometryInstanceAttribute.fromColor(buildingColor(height));
    for (const [outer, ...holes] of polygons) {
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(
              toPositions(outer!),
              holes.map((h) => new PolygonHierarchy(toPositions(h))),
            ),
            height: minHeight,
            extrudedHeight: height,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color },
        }),
      );
    }
  }
  if (instances.length === 0) return undefined;
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ translucent: false, closed: true }),
    asynchronous: true,
    releaseGeometryInstances: true,
    allowPicking: false,
  });
}

interface LoadedTile {
  primitive: Primitive | undefined;
}

/** Extruded OpenStreetMap buildings around the camera, loaded per z14 tile from our server. */
export class BuildingLayer {
  private enabled = false;
  private readonly shown = new Map<string, LoadedTile>();
  private readonly data = new Map<string, BuildingTile>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private wanted: TileRef[] = [];
  private controller = new AbortController();

  constructor(
    private readonly scene: Scene,
    private readonly credits: CreditDisplay,
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.credits.addStaticCredit(CREDIT);
      this.refresh();
    } else {
      this.credits.removeStaticCredit(CREDIT);
      this.clear();
    }
  }

  /** Recomputes which tiles are needed; call when the camera has moved. */
  refresh(): void {
    if (!this.enabled) return;
    const { camera } = this.scene;
    const height = camera.positionCartographic.height;
    if (height > MAX_CAMERA_HEIGHT_M) {
      this.wanted = [];
      this.prune();
      return;
    }
    const canvas = this.scene.canvas;
    const centre = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ground = camera.pickEllipsoid(centre);
    const focus = ground ? Cartographic.fromCartesian(ground) : camera.positionCartographic;
    const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, height * 2.5));
    this.wanted = tilesAround(
      (focus.longitude * 180) / Math.PI,
      (focus.latitude * 180) / Math.PI,
      radius,
      ZOOM,
      MAX_TILES,
    );
    this.prune();
    this.pump();
  }

  /** True while tile geometry is still being built (keeps the scene rendering). */
  update(): boolean {
    for (const tile of this.shown.values()) {
      if (tile.primitive && !tile.primitive.ready) return true;
    }
    return false;
  }

  destroy(): void {
    this.clear();
    this.controller.abort();
  }

  private clear(): void {
    for (const tile of this.shown.values()) this.removePrimitive(tile);
    this.shown.clear();
    this.wanted = [];
    this.scene.requestRender();
  }

  private prune(): void {
    const keep = new Set(this.wanted.map((t) => `${t.x}/${t.y}`));
    let removed = false;
    for (const [key, tile] of this.shown) {
      if (keep.has(key)) continue;
      this.removePrimitive(tile);
      this.shown.delete(key);
      removed = true;
    }
    if (removed) this.scene.requestRender();
  }

  private removePrimitive(tile: LoadedTile): void {
    if (tile.primitive && !this.scene.isDestroyed()) this.scene.primitives.remove(tile.primitive);
  }

  private pump(): void {
    for (const ref of this.wanted) {
      if (this.loading.size >= CONCURRENCY) return;
      const key = `${ref.x}/${ref.y}`;
      if (this.shown.has(key) || this.loading.has(key) || this.failed.has(key)) continue;
      const cached = this.data.get(key);
      if (cached) {
        this.show(key, cached);
        continue;
      }
      this.loading.add(key);
      fetchJson(`${TILE_URL}/${key}.json`, BuildingTileSchema, this.controller.signal)
        .then((tile) => {
          this.remember(key, tile);
          if (this.enabled && this.wanted.some((t) => `${t.x}/${t.y}` === key))
            this.show(key, tile);
        })
        .catch(() => {
          if (!this.controller.signal.aborted) this.failed.add(key);
        })
        .finally(() => {
          this.loading.delete(key);
          if (!this.controller.signal.aborted) this.pump();
        });
    }
  }

  private show(key: string, tile: BuildingTile): void {
    const primitive = primitiveFor(tile);
    if (primitive) this.scene.primitives.add(primitive);
    this.shown.set(key, { primitive });
    this.scene.requestRender();
  }

  private remember(key: string, tile: BuildingTile): void {
    this.data.set(key, tile);
    if (this.data.size <= MAX_CACHED_TILES) return;
    const oldest = this.data.keys().next().value;
    if (oldest !== undefined) this.data.delete(oldest);
  }
}
