import { BASEMAP_IDS, STYLE_IDS, type BasemapId, type StyleId } from '../config';
import type { CameraState } from '../engine/cameraState';
import type { TrackRef } from '../layers/contacts';

export interface UrlState {
  camera?: CameraState;
  basemap?: BasemapId;
  /** Undefined when the URL has no `layers` parameter, so defaults apply. */
  layers?: string[];
  style?: StyleId;
  hud?: boolean;
  detection?: boolean;
  track?: TrackRef;
  /** Ride along with the tracked object (cab view). */
  ride?: boolean;
}

const LAYER_ID = /^[a-z0-9-]{1,40}$/;
const MAX_LAYERS = 50;
const MAX_ID_LENGTH = 128;

/**
 * Parses `#cam=lon,lat,height,heading,pitch&map=dark&layers=a,b&style=nvg&hud=1&det=1&track=layer:id&ride=1`,
 * ignoring anything invalid.
 */
export function parseHash(hash: string): UrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const state: UrlState = {};

  const camera = parseCamera(params.get('cam'));
  if (camera) state.camera = camera;

  const map = params.get('map');
  if (map && (BASEMAP_IDS as readonly string[]).includes(map)) state.basemap = map as BasemapId;

  const layers = params.get('layers');
  if (layers !== null) {
    state.layers = [...new Set(layers.split(','))]
      .filter((id) => LAYER_ID.test(id))
      .slice(0, MAX_LAYERS);
  }

  const style = params.get('style');
  if (style && (STYLE_IDS as readonly string[]).includes(style)) state.style = style as StyleId;
  if (params.get('hud') === '1') state.hud = true;
  if (params.get('det') === '1') state.detection = true;

  const track = parseTrack(params.get('track'));
  if (track) {
    state.track = track;
    if (params.get('ride') === '1') state.ride = true;
  }
  return state;
}

function parseTrack(raw: string | null): TrackRef | undefined {
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  if (sep < 1) return undefined;
  const layerId = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!LAYER_ID.test(layerId) || id.length === 0 || id.length > MAX_ID_LENGTH) return undefined;
  return { layerId, id };
}

function parseCamera(raw: string | null): CameraState | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [lon, lat, height, heading, pitch] = parts as [number, number, number, number, number];
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined;
  if (height < 1 || height > 50_000_000 || pitch < -90 || pitch > 90) return undefined;
  const normalizedHeading = heading >= 0 && heading < 360 ? heading : ((heading % 360) + 360) % 360;
  return { lon, lat, height, heading: normalizedHeading, pitch };
}

export function serializeHash(state: UrlState): string {
  const parts: string[] = [];
  if (state.camera) {
    const c = state.camera;
    const cam = [
      c.lon.toFixed(5),
      c.lat.toFixed(5),
      Math.round(c.height),
      (Number(c.heading.toFixed(1)) % 360).toFixed(1),
      c.pitch.toFixed(1),
    ];
    parts.push(`cam=${cam.join(',')}`);
  }
  if (state.basemap) parts.push(`map=${state.basemap}`);
  if (state.layers) parts.push(`layers=${state.layers.join(',')}`);
  if (state.style && state.style !== 'normal') parts.push(`style=${state.style}`);
  if (state.hud) parts.push('hud=1');
  if (state.detection) parts.push('det=1');
  if (state.track) {
    parts.push(`track=${state.track.layerId}:${encodeURIComponent(state.track.id)}`);
    if (state.ride) parts.push('ride=1');
  }
  return parts.join('&');
}

export function writeHash(state: UrlState): void {
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}#${serializeHash(state)}`);
}
