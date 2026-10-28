export const GOTHENBURG = {
  center: { lon: 11.9746, lat: 57.7089 },
  bbox: { west: 11.6, south: 57.55, east: 12.25, north: 57.85 },
} as const;

/** `[lon, lat]` in degrees. */
export type LonLat = [number, number];

const LINE_SCALE = 1e5;

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/** Encodes a line with the Google polyline algorithm (1e-5° ≈ 1 m precision). */
export function encodeLine(coords: readonly LonLat[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * LINE_SCALE);
    const iLon = Math.round(lon * LINE_SCALE);
    out += encodeValue(iLat - prevLat) + encodeValue(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

/** Decodes `encodeLine` output; returns an empty array for malformed input. */
export function decodeLine(encoded: string): LonLat[] {
  const coords: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | undefined => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length || shift > 30) return undefined;
      const b = encoded.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return undefined;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === undefined || dLon === undefined) return [];
    lat += dLat;
    lon += dLon;
    coords.push([lon / LINE_SCALE, lat / LINE_SCALE]);
  }
  return coords;
}
