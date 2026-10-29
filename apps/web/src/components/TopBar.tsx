import type { ClientConfig } from '@gbg-osint/shared';
import type { Ref } from 'react';
import { BASEMAP_IDS, STYLE_IDS, STYLE_LABELS, type BasemapId, type StyleId } from '../config';
import { BASEMAPS, basemapAvailable } from '../engine/basemaps';
import type { SearchResult, EntityCandidate } from '../search/search';
import type { ConnectionState } from '../state/live';
import { SearchBox } from './SearchBox';

export type RightPanel = 'feed' | 'boards' | 'brief' | 'radio';

interface TopBarProps {
  basemap: BasemapId;
  clientKeys: ClientConfig;
  style: StyleId;
  hud: boolean;
  detection: boolean;
  density: number;
  connection: ConnectionState;
  layersOpen: boolean;
  rightPanel: RightPanel | null;
  toolsOpen: boolean;
  radioOn: boolean;
  searchRef: Ref<HTMLInputElement>;
  searchEntities: readonly EntityCandidate[];
  onSearchSelect(result: SearchResult): void;
  onBasemapChange(id: BasemapId): void;
  onStyleChange(id: StyleId): void;
  onToggleHud(): void;
  onToggleDetection(): void;
  onToggleLayers(): void;
  onToggleRight(panel: RightPanel): void;
  onToggleTools(): void;
  onOpenMissions(): void;
  onOpenScenes(): void;
  onShare(): void;
  onResetView(): void;
  onOpenHelp(): void;
  onOpenStatus(): void;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  open: 'Live',
  connecting: 'Connecting…',
  closed: 'Offline',
};

export function TopBar(props: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">GBG</span>
        <span className="brand-sep">//</span>
        <span>OSINT</span>
      </div>

      <nav className="topbar-actions" aria-label="Controls">
        <button type="button" aria-pressed={props.layersOpen} onClick={props.onToggleLayers}>
          Layers
        </button>
        <button
          type="button"
          aria-pressed={props.rightPanel === 'feed'}
          onClick={() => props.onToggleRight('feed')}
        >
          Feed
        </button>
        <button
          type="button"
          aria-pressed={props.rightPanel === 'boards'}
          onClick={() => props.onToggleRight('boards')}
          title="Departure boards (B)"
        >
          Boards
        </button>
        <button
          type="button"
          aria-pressed={props.rightPanel === 'brief'}
          onClick={() => props.onToggleRight('brief')}
          title="Now in Gothenburg: situation brief and delay index (N)"
        >
          Brief
        </button>
        <button
          type="button"
          aria-pressed={props.rightPanel === 'radio'}
          onClick={() => props.onToggleRight('radio')}
          title="Live radio"
        >
          Radio{props.radioOn ? ' ♪' : ''}
        </button>
        <button
          type="button"
          aria-pressed={props.toolsOpen}
          onClick={props.onToggleTools}
          title="Measure, pins and routes (G)"
        >
          Tools
        </button>
        <SearchBox
          inputRef={props.searchRef}
          entities={props.searchEntities}
          onSelect={props.onSearchSelect}
        />
        <label className="select">
          <span className="visually-hidden">Basemap</span>
          <select
            value={props.basemap}
            onChange={(e) => props.onBasemapChange(e.target.value as BasemapId)}
          >
            {BASEMAP_IDS.map((id) => (
              <option key={id} value={id} disabled={!basemapAvailable(id, props.clientKeys)}>
                {BASEMAPS[id].label}
              </option>
            ))}
          </select>
        </label>
        <label className="select" title="Visual effect only – not real sensor data">
          <span className="visually-hidden">Optics</span>
          <select
            value={props.style}
            onChange={(e) => props.onStyleChange(e.target.value as StyleId)}
          >
            {STYLE_IDS.map((id, i) => (
              <option key={id} value={id}>
                {i + 1} {STYLE_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" aria-pressed={props.hud} onClick={props.onToggleHud} title="HUD (H)">
          HUD
        </button>
        <button
          type="button"
          aria-pressed={props.detection}
          onClick={props.onToggleDetection}
          title="Detection boxes (D, Shift+D for density)"
        >
          DET{props.detection && props.density < 1 ? ` ${Math.round(props.density * 100)}%` : ''}
        </button>
        <button type="button" onClick={props.onOpenMissions} title="Missions (M)">
          Missions
        </button>
        <button type="button" onClick={props.onOpenScenes} title="Scene director (S)">
          Scenes
        </button>
        <button type="button" onClick={props.onShare} title="Copy a link to this view">
          Share
        </button>
        <button type="button" onClick={props.onResetView} title="Reset view (R)">
          Reset
        </button>
        <button type="button" onClick={props.onOpenHelp} aria-label="Keyboard shortcuts (?)">
          ?
        </button>
      </nav>

      <div className="topbar-status">
        <button
          type="button"
          className={`connection connection-${props.connection}`}
          onClick={props.onOpenStatus}
          title="Open source status"
        >
          <span className="dot" aria-hidden="true" />
          {CONNECTION_LABEL[props.connection]}
        </button>
      </div>
    </header>
  );
}
