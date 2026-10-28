/** Web-mercator (slippy map) tile helpers. */

export interface TileRef {
  x: number;
  y: number;
  distanceM: number;
}

const M_PER_DEG_LAT = 111_320;

export function lonLatOfTile(x: number, y: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat];
}

/** Fractional tile coordinates of a point. */
export function tileOf(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  ];
}

/** Tiles near a point (centre within `radiusM` plus half a tile diagonal), nearest first. */
export function tilesAround(
  lon: number,
  lat: number,
  radiusM: number,
  zoom: number,
  max: number,
): TileRef[] {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / mPerDegLon;
  const [x0, y1] = tileOf(lon - dLon, lat - dLat, zoom).map(Math.floor) as [number, number];
  const [x1, y0] = tileOf(lon + dLon, lat + dLat, zoom).map(Math.floor) as [number, number];
  const halfDiagonalM = ((40_075_000 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom) * Math.SQRT1_2;
  const tiles: TileRef[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const [cLon, cLat] = lonLatOfTile(x + 0.5, y + 0.5, zoom);
      const distanceM = Math.hypot((cLon - lon) * mPerDegLon, (cLat - lat) * M_PER_DEG_LAT);
      if (distanceM <= radiusM + halfDiagonalM) tiles.push({ x, y, distanceM });
    }
  }
  return tiles.sort((a, b) => a.distanceM - b.distanceM).slice(0, max);
}
