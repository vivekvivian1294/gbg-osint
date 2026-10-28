import type { LonLat } from '@gbg-osint/shared';
import type { IconId } from './icons';
import type { ModelKind } from './vehicleModels';

/** What was clicked: the layer and channel it came from, and the item id(s) behind the marker. */
export interface PickRef {
  layerId: string;
  channel: string;
  ids: readonly string[];
}

/** A 3D model drawn instead of the icon when the camera is close. */
export interface ModelSpec {
  kind: ModelKind;
  /** CSS colour for the accent parts (line colour, funnel). */
  accent: string;
  scale?: readonly [number, number, number];
  /** Camera distance in metres within which the model replaces the icon. */
  range: number;
}

/** A renderer-agnostic description of one map marker. */
export interface MarkerSpec {
  key: string;
  lon: number;
  lat: number;
  alt: number;
  /** Degrees clockwise from north; rotates the icon so it stays aligned with the ground. */
  heading?: number;
  icon: IconId;
  color: string;
  scale?: number;
  label?: string;
  labelMaxDistance?: number;
  /** Glide from the previous position over this many ms instead of jumping. */
  interpolateMs?: number;
  /**
   * Continuous playback this many ms behind the data, along the path of received positions,
   * easing to a halt when updates stop. Takes precedence over `interpolateMs`.
   */
  playbackDelayMs?: number;
  /** Route travelled since the previous position (excluding both ends), followed by playback. */
  via?: readonly LonLat[];
  /** Played-back markers are drawn this far right of their path (a bus in its lane). */
  laneOffsetM?: number;
  model?: ModelSpec;
  /** Source timestamp (epoch ms) and how long until the marker is shown as stale. */
  ts?: number;
  staleAfterMs?: number;
  /** Shown with a box in the detection overlay, e.g. `{ code: 'AC 484EE5', tag: '11 300 m' }`. */
  detect?: { code: string; tag?: string };
  /** Camera distance when tracking this marker; markers without it can't be tracked. */
  trackRange?: number;
  pick: PickRef;
}

export function isPickRef(value: unknown): value is PickRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'layerId' in value &&
    'channel' in value &&
    'ids' in value
  );
}
