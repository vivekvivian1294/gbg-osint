import type { DelayEntry, Departure } from '@gbg-osint/shared';

/** A departure this many minutes behind schedule counts as late. */
export const LATE_MIN = 3;
const WINDOW_BEFORE_MS = 30 * 60_000;
const WINDOW_AFTER_MS = 60 * 60_000;
const MODE_LABEL: Record<string, string> = {
  tram: 'Tram',
  bus: 'Bus',
  ferry: 'Ferry',
  train: 'Train',
};
/** Boards that make up the transit delay index (flights, road ferries and ships are separate). */
const INDEX_SOURCES = new Set(['vasttrafik', 'trafikverket']);
const INDEX_MODES = new Set(['tram', 'bus', 'ferry', 'train']);

export function delayMin(d: Departure): number {
  if (!d.expected) return 0;
  return Math.round((Date.parse(d.expected) - Date.parse(d.planned)) / 60_000);
}

/** Departures planned from half an hour ago to an hour ahead. */
function inWindow(d: Departure, now: number): boolean {
  const planned = Date.parse(d.planned);
  return planned >= now - WINDOW_BEFORE_MS && planned <= now + WINDOW_AFTER_MS;
}

const isLate = (d: Departure) => d.cancelled || delayMin(d) >= LATE_MIN;

export function lateCount(rows: readonly Departure[], now: number): number {
  return rows.filter((d) => inWindow(d, now) && isLate(d)).length;
}

function entry(name: string, mode: string, rows: readonly Departure[]): DelayEntry {
  const running = rows.filter((d) => !d.cancelled).map((d) => Math.max(0, delayMin(d)));
  return {
    name,
    mode,
    departures: rows.length,
    late: rows.filter(isLate).length,
    cancelled: rows.filter((d) => d.cancelled).length,
    meanDelayMin:
      running.length > 0
        ? Math.round((running.reduce((a, b) => a + b, 0) / running.length) * 10) / 10
        : 0,
    maxDelayMin: Math.max(0, ...running),
  };
}

const score = (e: DelayEntry) => (e.cancelled / e.departures) * 20 + e.meanDelayMin;

/** Worst lines and hubs on the transit boards, around now. */
export function delayIndex(
  rows: readonly Departure[],
  now: number,
): { lines: DelayEntry[]; hubs: DelayEntry[] } {
  const relevant = rows.filter(
    (d) => INDEX_SOURCES.has(d.source) && INDEX_MODES.has(d.mode) && inWindow(d, now),
  );
  const byLine = new Map<string, Departure[]>();
  const byHub = new Map<string, Departure[]>();
  for (const d of relevant) {
    if (d.source === 'vasttrafik') {
      const key = `${d.mode}|${d.line}`;
      byLine.set(key, [...(byLine.get(key) ?? []), d]);
    }
    byHub.set(d.board, [...(byHub.get(d.board) ?? []), d]);
  }
  const lines = [...byLine]
    .map(([key, list]) => {
      const [mode, line] = key.split('|') as [string, string];
      return entry(`${MODE_LABEL[mode] ?? mode} ${line}`, mode, list);
    })
    .filter((e) => e.departures >= 2 && (e.late > 0 || e.cancelled > 0))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 6);
  const hubs = [...byHub]
    .map(([board, list]) => entry(board, list[0]!.mode, list))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 8);
  return { lines, hubs };
}
