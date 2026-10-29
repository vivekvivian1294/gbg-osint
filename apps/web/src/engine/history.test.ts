import { describe, expect, it } from 'vitest';
import { sparkPath } from '../components/Sparkline';
import { trailSegments } from './historyTrail';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const HOUR = 3600_000;

describe('sparklines', () => {
  it('spreads the last 24 hours across the width and the value range across the height', () => {
    expect(
      sparkPath(
        [
          [NOW - 24 * HOUR, 0],
          [NOW - 12 * HOUR, 5],
          [NOW, 10],
        ],
        NOW,
        72,
        18,
      ),
    ).toBe('0.0,17.0 36.0,9.0 72.0,1.0');
  });

  it('stretches shorter histories across the width and centres a constant value', () => {
    expect(
      sparkPath(
        [
          [NOW - HOUR, 4],
          [NOW - HOUR / 2, 4],
        ],
        NOW,
        72,
        18,
      ),
    ).toBe('0.0,9.0 36.0,9.0');
    expect(sparkPath([[NOW, 4]], NOW)).toBe('');
  });

  it('keeps only the last 24 hours on the axis', () => {
    expect(
      sparkPath(
        [
          [NOW - 30 * HOUR, 1],
          [NOW, 2],
        ],
        NOW,
        72,
        18,
      ),
    ).toBe('0.0,17.0 72.0,1.0');
  });
});

describe('24-hour trails', () => {
  it('breaks the line at long gaps and drops lone points', () => {
    const p = (minutes: number): [number, number, number, number] => [
      NOW + minutes * 60_000,
      11.9,
      57.7,
      0,
    ];
    expect(trailSegments([p(0), p(5), p(10), p(90), p(200), p(205)])).toEqual([
      [p(0), p(5), p(10)],
      [p(200), p(205)],
    ]);
    expect(trailSegments([p(0)])).toEqual([]);
  });
});
