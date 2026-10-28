import type { Metric } from '@gbg-osint/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChannelStore } from './store';

const metric = (id: string, value: number): Metric => ({
  id,
  source: 'test',
  name: id,
  unit: 'x',
  value,
  ts: '2026-10-23T10:00:00Z',
});

describe('ChannelStore', () => {
  it('emits only changes on replace', () => {
    const store = new ChannelStore();
    store.register('test.metrics', 'metrics', 'test');
    const listener = vi.fn();
    store.onDelta(listener);

    store.replace('test.metrics', [metric('a', 1), metric('b', 2)]);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ upsert: [metric('a', 1), metric('b', 2)], remove: [] }),
    );

    store.replace('test.metrics', [metric('a', 1), metric('c', 3)]);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ upsert: [metric('c', 3)], remove: ['b'] }),
    );

    listener.mockClear();
    expect(store.replace('test.metrics', [metric('a', 1), metric('c', 3)])).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot('test.metrics')).toHaveLength(2);
  });

  it('applies incremental upserts and removals', () => {
    const store = new ChannelStore();
    store.register('test.metrics', 'metrics', 'test');
    store.apply('test.metrics', [metric('a', 1), metric('b', 2)]);
    const delta = store.apply('test.metrics', [metric('a', 5)], ['b', 'missing']);
    expect(delta).toMatchObject({ upsert: [metric('a', 5)], remove: ['b'] });
    expect(store.snapshot('test.metrics')).toEqual([metric('a', 5)]);
  });

  it('rejects unknown and duplicate channels', () => {
    const store = new ChannelStore();
    store.register('test.metrics', 'metrics', 'test');
    expect(() => store.register('test.metrics', 'metrics', 'test')).toThrow();
    expect(() => store.snapshot('nope.channel')).toThrow();
    expect(store.list()).toEqual([{ name: 'test.metrics', kind: 'metrics', sourceId: 'test' }]);
  });
});
