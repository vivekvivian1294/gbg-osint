import { STYLE_IDS, STYLE_LABELS } from '../config';
import { Modal } from './Modal';

const SHORTCUTS: readonly [string, string][] = [
  ...STYLE_IDS.map((id, i): [string, string] => [String(i + 1), `Optics: ${STYLE_LABELS[id]}`]),
  ['H', 'Toggle HUD'],
  ['D', 'Toggle detection boxes'],
  ['Shift + D', 'Cycle detection density'],
  ['T', 'Track the selected object / stop tracking'],
  ['C', 'Ride along with the tracked vehicle, ship or aircraft'],
  ['← →', 'Step through contacts while tracking'],
  ['R', 'Reset to the city view'],
  ['/', 'Search'],
  ['B', 'Departure boards'],
  ['N', 'Now in Gothenburg (situation brief)'],
  ['W', "What's here? at the centre of the view (or right-click, or long-press)"],
  ['M', 'Missions'],
  ['S', 'Scene director (camera tours)'],
  ['G', 'Map tools: measure, pins, route A→B, watch areas'],
  ['E', 'Export the selection or view (GeoJSON, CSV) or a screenshot'],
  ['Esc', 'Leave the tool, stop tracking and tours, clear the selection'],
  ['?', 'This help'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([key, action]) => (
          <div key={key} className="dl-row">
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
