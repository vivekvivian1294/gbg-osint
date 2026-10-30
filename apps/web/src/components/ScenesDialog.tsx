import { useEffect, useRef, useState } from 'react';
import type { Tour, TourKeyframe } from '../engine/tours';
import { tourDuration } from '../engine/tours';
import { downloadFile, slug } from '../state/download';
import {
  loadImportedTours,
  MAX_IMPORTED_TOURS,
  MAX_SCENE_BYTES,
  parseSceneFile,
  saveImportedTours,
  sceneFile,
} from '../state/sceneFiles';
import { recordedTour, TOURS } from '../tours';
import { Modal } from './Modal';

interface ScenesDialogProps {
  open: boolean;
  recording: readonly TourKeyframe[];
  /** Layers on now, saved with the recorded tour. */
  layers: readonly string[];
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
  const [imported, setImported] = useState(loadImportedTours);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => saveImportedTours(imported), [imported]);

  const saveRecording = () => {
    const tour = recordedTour([...recording]);
    downloadFile(
      `gbg-osint-tour-${slug(tour.title, 'tour')}.json`,
      sceneFile(tour, props.layers),
      'application/json',
    );
  };

  const openFile = async (file: File) => {
    setFileError(null);
    if (file.size > MAX_SCENE_BYTES) {
      setFileError('The file is too large for a tour.');
      return;
    }
    try {
      const tour = parseSceneFile(await file.text());
      setImported((prev) => [tour, ...prev].slice(0, MAX_IMPORTED_TOURS));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'The file could not be read.');
    }
  };
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
        <button type="button" onClick={saveRecording} disabled={recording.length < 2}>
          Save as file
        </button>
        <button type="button" onClick={props.onClearRecording} disabled={recording.length === 0}>
          Clear
        </button>
      </div>
      <h3 className="contacts-title">Tour files</h3>
      <p className="muted">
        Share tours as small files. A saved tour includes its views and the layers that were on.
        Opened tours are kept in this browser.
      </p>
      {imported.length > 0 && (
        <ul className="mission-list">
          {imported.map((t) => (
            <li key={t.id} className="scene-file">
              <button type="button" onClick={() => props.onPlay(t)}>
                <strong>{t.title}</strong>
                <span>{t.summary}</span>
                <span className="badge">{seconds(tourDuration(t))}</span>
              </button>
              <button
                type="button"
                className="scene-remove"
                aria-label={`Remove ${t.title}`}
                title="Remove from this browser"
                onClick={() => setImported((prev) => prev.filter((x) => x.id !== t.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="selection-actions">
        <button type="button" onClick={() => fileInput.current?.click()}>
          Open tour file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void openFile(file);
          }}
        />
      </div>
      {fileError && (
        <p className="scene-error" role="alert">
          {fileError}
        </p>
      )}
    </Modal>
  );
}
