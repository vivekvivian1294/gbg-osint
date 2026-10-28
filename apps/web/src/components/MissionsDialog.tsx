import { STYLE_LABELS } from '../config';
import { MISSIONS, type Mission } from '../missions';
import { Modal } from './Modal';

interface MissionsDialogProps {
  open: boolean;
  onClose(): void;
  onSelect(mission: Mission): void;
}

export function MissionsDialog({ open, onClose, onSelect }: MissionsDialogProps) {
  return (
    <Modal open={open} title="Missions" className="missions-dialog" onClose={onClose}>
      <p className="muted">
        Pick a starting point. Each mission sets layers, optics and the camera; you can change
        everything afterwards.
      </p>
      <ul className="mission-list">
        {MISSIONS.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => onSelect(m)}>
              <strong>{m.title}</strong>
              <span>{m.summary}</span>
              <span className="badge">{STYLE_LABELS[m.style]}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="disclaimer">
        Night-vision and thermal looks are visual effects applied to the map, not real sensor data.
      </p>
    </Modal>
  );
}
