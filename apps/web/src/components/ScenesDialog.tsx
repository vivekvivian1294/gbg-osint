import type { Tour, TourKeyframe } from '../engine/tours';
import { tourDuration } from '../engine/tours';
import { TOURS } from '../tours';
import { Modal } from './Modal';

interface ScenesDialogProps {
  open: boolean;
  recording: readonly TourKeyframe[];
  onClose(): void;
  onPlay(tour: Tour): void;
  onPlayRecording(): void;
  onAddView(): void;
  onClearRecording(): void;
}

const seconds = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function ScenesDialog(props: ScenesDialogProps) {
  const { recording } = props;
  return (
    <Modal
      open={props.open}
      title="Scene director"
      className="missions-dialog"
      onClose={props.onClose}
    >
      <p className="muted">
        Camera tours over Gothenburg. Live layers keep updating while a tour plays; drag the map or
        press Esc to take over.
      </p>
      <ul className="mission-list">
        {TOURS.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => props.onPlay(t)}>
              <strong>{t.title}</strong>
              <span>{t.summary}</span>
              <span className="badge">{seconds(tourDuration(t))}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="contacts-title">Your tour</h3>
      <p className="muted">
        Move the camera, then add the view. Views are joined by a smooth flight, 8 s apart, and kept
        in this browser.
      </p>
      <div className="selection-actions">
        <button type="button" onClick={props.onAddView}>
          Add current view
        </button>
        <button type="button" onClick={props.onPlayRecording} disabled={recording.length < 2}>
          Play ({recording.length} views)
        </button>
        <button type="button" onClick={props.onClearRecording} disabled={recording.length === 0}>
          Clear
        </button>
      </div>
    </Modal>
  );
}
