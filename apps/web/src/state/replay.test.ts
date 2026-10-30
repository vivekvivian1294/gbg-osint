import { describe, expect, it } from 'vitest';
import { isReplayable, STATIC_CHANNELS } from './replay';

describe('replay', () => {
  it('replays events, readings and recorded objects only', () => {
    expect(isReplayable('events.road', 'events')).toBe(true);
    expect(isReplayable('env.weather', 'metrics')).toBe(true);
    expect(isReplayable('maritime.ships', 'entities')).toBe(true);
    expect(isReplayable('env.harbour', 'entities')).toBe(true);
    expect(isReplayable('transit.vehicles', 'entities')).toBe(false);
    expect(isReplayable('transit.departures', 'departures')).toBe(false);
    expect(isReplayable('env.radar', 'frames')).toBe(false);
    expect(isReplayable('events.road', undefined)).toBe(false);
    expect(STATIC_CHANNELS.has('context.districts')).toBe(true);
  });
});
