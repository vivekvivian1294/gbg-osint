import type { Departure } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import type { TrackRef } from '../layers/contacts';

interface BoardsPanelProps {
  rows: readonly Departure[];
  hasBoardLayers: boolean;
  /** Live aircraft by callsign, so flights on the board can be tracked on the map. */
  aircraftByCallsign: ReadonlyMap<string, TrackRef>;
  /** A line shown above a board, e.g. the airport's latest METAR. */
  notes?: ReadonlyMap<string, string>;
  onTrack(ref: TrackRef): void;
}

const MAX_ROWS = 40;
const CLOCK_TICK_MS = 30_000;
/** Rows stay visible this long after their (expected) time. */
const KEEP_PAST_MS = 5 * 60_000;
const LATE_MS = 60_000;
const BOARD_ORDER = ['Göteborg C', 'Göteborg Landvetter (GOT)'];

const hhmm = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

function boardRank(name: string): number {
  const i = BOARD_ORDER.indexOf(name);
  return i === -1 ? BOARD_ORDER.length : i;
}

function LineBadge({ row }: { row: Departure }) {
  const style = row.colors ? { color: row.colors.fg, background: row.colors.bg } : undefined;
  return (
    <span className={row.colors ? 'line-badge' : 'line-text'} style={style}>
      {row.line}
    </span>
  );
}

function TimeCell({ row }: { row: Departure }) {
  const planned = Date.parse(row.planned);
  const expected = row.expected ? Date.parse(row.expected) : planned;
  const late = expected - planned >= LATE_MS;
  return (
    <td className="board-time">
      <time dateTime={row.planned} className={late || row.cancelled ? 'superseded' : undefined}>
        {hhmm.format(planned)}
      </time>
      {late && !row.cancelled && (
        <time dateTime={row.expected} className="late">
          {hhmm.format(expected)}
        </time>
      )}
    </td>
  );
}

export function BoardsPanel({
  rows,
  hasBoardLayers,
  aircraftByCallsign,
  notes,
  onTrack,
}: BoardsPanelProps) {
  const boards = [...new Set(rows.map((r) => r.board))].sort(
    (a, b) => boardRank(a) - boardRank(b) || a.localeCompare(b, 'sv'),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [direction, setDirection] = useState<Departure['direction']>('departure');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const board = chosen && boards.includes(chosen) ? chosen : boards[0];

  if (!board) {
    return (
      <p className="empty">
        {hasBoardLayers
          ? 'Waiting for departures…'
          : 'No departure boards are active. Turn one on under “Departure boards”.'}
      </p>
    );
  }

  const onBoard = rows.filter((r) => r.board === board);
  const hasArrivals = onBoard.some((r) => r.direction === 'arrival');
  const shownDirection = hasArrivals ? direction : 'departure';
  const visible = onBoard
    .filter((r) => r.direction === shownDirection)
    .map((r) => ({ row: r, at: Date.parse(r.expected ?? r.planned) }))
    .filter(({ at }) => at >= now - KEEP_PAST_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_ROWS);
  const placeHeader = shownDirection === 'arrival' ? 'From' : 'To';
  const platformHeader = onBoard[0]?.mode === 'flight' ? 'Gate' : 'Pl.';
  // Road ferry boards list where each crossing leaves from instead of a line.
  const roadFerries = onBoard.every((r) => r.mode === 'ferry' && r.source === 'trafikverket');
  const note = notes?.get(board);

  return (
    <div className="boards">
      <div className="boards-controls">
        <label className="select">
          <span className="visually-hidden">Board</span>
          <select value={board} onChange={(e) => setChosen(e.target.value)}>
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        {hasArrivals && (
          <div className="segmented" role="group" aria-label="Direction">
            <button
              type="button"
              aria-pressed={shownDirection === 'departure'}
              onClick={() => setDirection('departure')}
            >
              Departures
            </button>
            <button
              type="button"
              aria-pressed={shownDirection === 'arrival'}
              onClick={() => setDirection('arrival')}
            >
              Arrivals
            </button>
          </div>
        )}
      </div>
      {note && <p className="board-note">{note}</p>}
      {visible.length === 0 ? (
        <p className="empty">Nothing scheduled in the next hours.</p>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">{roadFerries ? 'From' : 'Line'}</th>
              <th scope="col">{placeHeader}</th>
              <th scope="col">{platformHeader}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, at }) => {
              const aircraft = row.callsign ? aircraftByCallsign.get(row.callsign) : undefined;
              const past = at < now;
              return (
                <tr
                  key={`${row.source}:${row.id}`}
                  className={row.cancelled ? 'cancelled' : past ? 'past' : undefined}
                >
                  <TimeCell row={row} />
                  <td>
                    <LineBadge row={row} />
                  </td>
                  <td>
                    <span className="board-place">{row.place}</span>
                    {(row.status || row.operator) && (
                      <span className="board-status">
                        {[row.status, row.operator].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="board-platform">
                    {row.platform ?? ''}
                    {aircraft && (
                      <button
                        type="button"
                        className="board-track"
                        onClick={() => onTrack(aircraft)}
                        title={`Track ${row.callsign} on the map`}
                        aria-label={`Track ${row.line} on the map`}
                      >
                        ◎
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
