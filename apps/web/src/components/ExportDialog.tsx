import { useState } from 'react';
import { downloadFile, slug } from '../state/download';
import { fileStamp, toCsv, toGeoJson, type ExportRecord } from '../state/exportData';
import { Modal } from './Modal';

export interface ExportSet {
  title: string;
  records: readonly ExportRecord[];
  /** Who the data comes from, e.g. "Trafikverket (CC0)". */
  attribution: readonly string[];
}

interface ExportDialogProps {
  open: boolean;
  selection: ExportSet | null;
  /** Null when the view is unknown (e.g. looking at the sky). */
  view: ExportSet | null;
  onScreenshot(): Promise<boolean>;
  onClose(): void;
}

function layerCounts(records: readonly ExportRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.layer, (counts.get(r.layer) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const items = (n: number) => `${n.toLocaleString('sv-SE')} ${n === 1 ? 'item' : 'items'}`;

export function ExportDialog({ open, selection, view, onScreenshot, onClose }: ExportDialogProps) {
  const [capturing, setCapturing] = useState(false);

  const save = (set: ExportSet, scope: string, format: 'geojson' | 'csv') => {
    const now = new Date();
    const name = [`gbg-osint-${scope}`, set.title && slug(set.title, scope), fileStamp(now)]
      .filter(Boolean)
      .join('-');
    const file = `${name}.${format}`;
    if (format === 'csv') downloadFile(file, toCsv(set.records), 'text/csv;charset=utf-8');
    else {
      const meta = { generated: now.toISOString(), attribution: set.attribution };
      downloadFile(file, toGeoJson(set.records, meta), 'application/geo+json');
    }
  };

  const formats = (set: ExportSet, scope: string) => (
    <div className="selection-actions">
      <button
        type="button"
        disabled={set.records.length === 0}
        onClick={() => save(set, scope, 'geojson')}
      >
        GeoJSON
      </button>
      <button
        type="button"
        disabled={set.records.length === 0}
        onClick={() => save(set, scope, 'csv')}
      >
        CSV
      </button>
    </div>
  );

  return (
    <Modal open={open} title="Export" className="export-dialog" onClose={onClose}>
      <h3>Selection</h3>
      {selection ? (
        <>
          <p>
            {selection.title} · {items(selection.records.length)}
          </p>
          {formats(selection, 'selection')}
        </>
      ) : (
        <p className="muted">Nothing selected. Click something on the map first.</p>
      )}

      <h3>Everything in view</h3>
      {view ? (
        <>
          <p>
            {items(view.records.length)} from the layers that are on
            {view.records.length > 0 && ':'}
          </p>
          {view.records.length > 0 && (
            <ul className="export-layers">
              {layerCounts(view.records).map(([layer, n]) => (
                <li key={layer}>
                  <span>{layer}</span>
                  <span className="muted">{n.toLocaleString('sv-SE')}</span>
                </li>
              ))}
            </ul>
          )}
          {formats(view, 'view')}
        </>
      ) : (
        <p className="muted">The view shows no ground. Point the camera at the map first.</p>
      )}

      <h3>Screenshot</h3>
      <p className="muted">The map as you see it, as a PNG with the data and map credits.</p>
      <div className="selection-actions">
        <button
          type="button"
          disabled={capturing}
          onClick={() => {
            setCapturing(true);
            void onScreenshot().finally(() => setCapturing(false));
          }}
        >
          {capturing ? 'Saving…' : 'Save screenshot'}
        </button>
      </div>

      <p className="muted small">
        Files include each item's source and the current time. Departures and radar images are not
        exported, nor are news without a place. Check each source's licence (listed in GeoJSON files
        and under the status dialog) before sharing.
      </p>
    </Modal>
  );
}
