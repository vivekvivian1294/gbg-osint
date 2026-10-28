import type { CameraState } from '../engine/cameraState';
import { useStore, type Store } from '../state/store';

function formatCoord(value: number, pos: string, neg: string): string {
  return `${Math.abs(value).toFixed(5)}° ${value >= 0 ? pos : neg}`;
}

export function CameraReadout({ store }: { store: Store<CameraState> }) {
  const camera = useStore(store);
  return (
    <div className="readout" aria-label="Camera position">
      <span>CAM {formatCoord(camera.lat, 'N', 'S')}</span>
      <span>{formatCoord(camera.lon, 'E', 'W')}</span>
      <span>ALT {Math.round(camera.height).toLocaleString('sv-SE')} m</span>
      <span>HDG {(Math.round(camera.heading) % 360).toString().padStart(3, '0')}°</span>
      <span>PITCH {Math.round(camera.pitch)}°</span>
    </div>
  );
}
