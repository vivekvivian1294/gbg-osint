import { GOTHENBURG } from '@gbg-osint/shared';

/** Camera position and orientation, in degrees and metres. */
export interface CameraState {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
}

const HOME_HEIGHT_M = 7000;
const HOME_PITCH_DEG = -35;
const METRES_PER_DEGREE_LAT = 111_320;

/** A camera south of the target looking north at it from the given height and pitch. */
export function viewOf(
  lon: number,
  lat: number,
  height: number,
  pitch = HOME_PITCH_DEG,
): CameraState {
  const groundOffset = pitch <= -89 ? 0 : height / Math.tan((-pitch * Math.PI) / 180);
  return { lon, lat: lat - groundOffset / METRES_PER_DEGREE_LAT, height, heading: 0, pitch };
}

/** An oblique view looking north over central Gothenburg. */
export function homeCamera(): CameraState {
  return viewOf(GOTHENBURG.center.lon, GOTHENBURG.center.lat, HOME_HEIGHT_M);
}
