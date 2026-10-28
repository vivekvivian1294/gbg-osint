import { HealthSchema, type Health, type SourceStatus } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { fetchJson } from '../state/api';
import type { ConnectionState } from '../state/live';
import { Modal } from './Modal';

interface StatusDialogProps {
  open: boolean;
  onClose(): void;
  sources: readonly SourceStatus[];
  catalogError: string | null;
  connection: ConnectionState;
}

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function StatusDialog({
  open,
  onClose,
  sources,
  catalogError,
  connection,
}: StatusDialogProps) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchJson('/api/health', HealthSchema, controller.signal).then(
      (h) => {
        setHealth(h);
        setHealthError(false);
      },
      () => {
        if (!controller.signal.aborted) setHealthError(true);
      },
    );
    return () => controller.abort();
  }, [open]);

  return (
    <Modal open={open} title="System status" className="status-dialog" onClose={onClose}>
      <dl className="status-summary">
        <dt>Server</dt>
        <dd>
          {healthError || catalogError
            ? 'Unreachable'
            : health
              ? `OK · v${health.version} · up ${formatDuration(health.uptimeSec)}`
              : 'Checking…'}
        </dd>
        <dt>Live connection</dt>
        <dd>{connection}</dd>
      </dl>

      <h3>Data sources</h3>
      {sources.length === 0 ? (
        <p className="empty">No data sources are registered yet. They arrive in Phase 1.</p>
      ) : (
        <table className="sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">State</th>
              <th scope="col">Last update</th>
              <th scope="col">Licence</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.homepage ? (
                    <a href={s.homepage} target="_blank" rel="noopener noreferrer">
                      {s.name}
                    </a>
                  ) : (
                    s.name
                  )}
                </td>
                <td>
                  <span className={`state-dot state-${s.state}`} aria-hidden="true" /> {s.state}
                  {s.reason && <div className="muted">{s.reason}</div>}
                </td>
                <td>{s.lastSuccess ? timeFormat.format(new Date(s.lastSuccess)) : '—'}</td>
                <td>{s.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="disclaimer">
        Exploratory view of public data. It may be delayed, incomplete or wrong. Not for navigation
        or emergencies; in an emergency call 112.
      </p>
    </Modal>
  );
}

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${totalSec % 60}s`;
}
