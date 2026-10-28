import { STYLE_LABELS, type StyleId } from '../config';
import type { CameraState } from '../engine/cameraState';
import type { OverlayStats } from '../engine/overlay';
import { useStore, type Store } from '../state/store';

interface HudProps {
  cameraStore: Store<CameraState>;
  statsStore: Store<OverlayStats>;
  style: StyleId;
  feeds: { ok: number; total: number };
  trackedLabel: string | null;
  live: boolean;
}

const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const TAPE_WIDTH = 360;
const TAPE_SPAN_DEG = 60;

function CompassTape({ heading }: { heading: number }) {
  const pxPerDeg = TAPE_WIDTH / (2 * TAPE_SPAN_DEG);
  const marks = [];
  for (let d = Math.ceil((heading - TAPE_SPAN_DEG) / 5) * 5; d <= heading + TAPE_SPAN_DEG; d += 5) {
    const x = TAPE_WIDTH / 2 + (d - heading) * pxPerDeg;
    const norm = ((d % 360) + 360) % 360;
    const major = norm % 30 === 0;
    marks.push(<line key={`l${d}`} x1={x} x2={x} y1={major ? 4 : 10} y2={16} />);
    if (major) {
      marks.push(
        <text key={`t${d}`} x={x} y={29}>
          {CARDINALS[norm] ?? String(norm).padStart(3, '0')}
        </text>,
      );
    }
  }
  return (
    <svg className="hud-compass" viewBox={`0 0 ${TAPE_WIDTH} 34`} width={TAPE_WIDTH} height={34}>
      {marks}
      <polygon points={`${TAPE_WIDTH / 2 - 5},0 ${TAPE_WIDTH / 2 + 5},0 ${TAPE_WIDTH / 2},6`} />
    </svg>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString('sv-SE');

/** Ops-room frame over the globe. Decorative: the same data is available in the bars and dialogs. */
export function Hud({ cameraStore, statsStore, style, feeds, trackedLabel, live }: HudProps) {
  const camera = useStore(cameraStore);
  const stats = useStore(statsStore);
  const heading = Math.round(camera.heading) % 360;
  return (
    <div className="hud" aria-hidden="true">
      <span className="hud-corner hud-tl" />
      <span className="hud-corner hud-tr" />
      <span className="hud-corner hud-bl" />
      <span className="hud-corner hud-br" />
      <span className="hud-reticle" />
      <div className="hud-bottom">
        <CompassTape heading={camera.heading} />
        <div className="hud-line">
          <span>MODE {STYLE_LABELS[style].toUpperCase()}</span>
          <span>ALT {fmt(camera.height)} m</span>
          <span>HDG {String(heading).padStart(3, '0')}°</span>
          <span>PITCH {Math.round(camera.pitch)}°</span>
          <span>CONTACTS {stats.contactsInView}</span>
          <span>MARKERS {stats.markersInView}</span>
          <span className={feeds.ok < feeds.total ? 'hud-warn' : undefined}>
            FEEDS {feeds.ok}/{feeds.total}
          </span>
          {trackedLabel && <span className="hud-trk">TRK {trackedLabel}</span>}
          <span className={live ? 'hud-live' : 'hud-warn'}>{live ? '● LIVE' : '○ OFFLINE'}</span>
        </div>
      </div>
    </div>
  );
}
