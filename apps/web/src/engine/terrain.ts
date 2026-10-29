import {
  Cartographic,
  Cesium3DTileset,
  createOsmBuildingsAsync,
  createWorldTerrainAsync,
  EllipsoidTerrainProvider,
  Ion,
  type CesiumWidget,
} from 'cesium';

/**
 * Mean sea level above the WGS84 ellipsoid around Gothenburg (geoid height). Terrain heights are
 * ellipsoidal, while aircraft report altitude above sea level.
 */
export const GEOID_M = 35;

/** Cell size for cached surface heights, about 12 × 22 m here. */
const CELL_DEG = 0.0002;
const MAX_CACHED = 200_000;
/** Refined tiles change heights slightly; don't recompute more often than this. */
const REFRESH_MS = 1_500;

/** Heights for drawing on the globe: the plain ellipsoid, or real terrain when it is on. */
export class Ground {
  terrain = false;
  /** Increments whenever heights may have changed (terrain switched, tiles refined). */
  version = 0;
  private readonly scratch = new Cartographic();
  private readonly cache = new Map<number, number>();
  private refreshedAt = 0;

  constructor(private readonly globe: CesiumWidget) {}

  /** Ellipsoid height of the drawn surface at a point (0 without terrain). */
  surface(lon: number, lat: number): number {
    if (!this.terrain) return 0;
    const key = Math.round(lon / CELL_DEG) * 1e7 + Math.round(lat / CELL_DEG);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const c = Cartographic.fromDegrees(lon, lat, 0, this.scratch);
    const height = this.globe.scene.globe.getHeight(c);
    // Not loaded yet: sea level is the best guess around the harbour; try again later.
    if (height === undefined) return GEOID_M;
    if (this.cache.size >= MAX_CACHED) this.cache.clear();
    this.cache.set(key, height);
    return height;
  }

  /** Ellipsoid height for something reported at `alt`: on the ground at 0, else above sea level. */
  heightOf(lon: number, lat: number, alt: number): number {
    if (!this.terrain) return alt;
    return alt > 0 ? alt + GEOID_M : this.surface(lon, lat) + alt;
  }

  /** Drops cached heights once newly loaded tiles may have refined them; true if it did. */
  refresh(now: number, force = false): boolean {
    if (!this.terrain || (!force && now - this.refreshedAt < REFRESH_MS)) return false;
    this.refreshedAt = now;
    this.cache.clear();
    this.version++;
    return true;
  }
}

/** Switches Cesium World Terrain and Cesium OSM Buildings (both via Cesium ion) on and off. */
export class TerrainController {
  private buildings: Cesium3DTileset | undefined;
  private request = 0;

  constructor(
    private readonly globe: CesiumWidget,
    private readonly ground: Ground,
    private readonly onChange: () => void,
  ) {}

  async set(enabled: boolean, token: string | undefined, showBuildings: boolean): Promise<void> {
    const request = ++this.request;
    const { scene } = this.globe;
    if (!enabled || !token) {
      if (this.ground.terrain) {
        this.ground.refresh(0, true);
        scene.terrainProvider = new EllipsoidTerrainProvider();
        scene.globe.depthTestAgainstTerrain = false;
        this.ground.terrain = false;
        this.onChange();
      }
      if (this.buildings) this.buildings.show = false;
      scene.requestRender();
      return;
    }
    Ion.defaultAccessToken = token;
    if (!this.ground.terrain) {
      const provider = await createWorldTerrainAsync();
      if (request !== this.request || this.globe.isDestroyed()) return;
      scene.terrainProvider = provider;
      scene.globe.depthTestAgainstTerrain = true;
      this.ground.terrain = true;
      this.ground.refresh(0, true);
      this.onChange();
    }
    if (showBuildings && !this.buildings) {
      const tileset = await createOsmBuildingsAsync();
      if (this.globe.isDestroyed()) return;
      this.buildings = scene.primitives.add(tileset);
    }
    if (this.buildings) this.buildings.show = showBuildings && this.ground.terrain;
    scene.requestRender();
  }

  destroy(): void {
    this.request++;
    if (this.buildings && !this.globe.isDestroyed())
      this.globe.scene.primitives.remove(this.buildings);
    this.buildings = undefined;
  }
}
