import type { ChannelItem, ChannelKind } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { buildMarkers } from './markers';
import { LAYER_BY_ID } from './registry';

const layer = (id: string) => {
  const l = LAYER_BY_ID.get(id);
  if (!l) throw new Error(id);
  return l;
};

const kinds = new Map<string, ChannelKind>([
  ['aviation.aircraft', 'entities'],
  ['events.police', 'events'],
  ['env.weather', 'metrics'],
]);

describe('buildMarkers', () => {
  it('styles entities and keeps their heading and stale settings', () => {
    const items: Record<string, ChannelItem[]> = {
      'aviation.aircraft': [
        {
          id: 'abc123',
          source: 'adsb.fi',
          kind: 'aircraft',
          lon: 12,
          lat: 57.7,
          alt: 3000,
          heading: 90,
          label: 'SAS123',
          ts: '2026-10-23T10:00:00Z',
          props: { military: true },
        },
      ],
    };
    const [m] = buildMarkers([layer('aircraft')], kinds, (c) => items[c] ?? []);
    expect(m).toMatchObject({
      key: 'aircraft|aviation.aircraft|abc123',
      icon: 'aircraft',
      color: '#fbbf24',
      heading: 90,
      label: 'SAS123',
      interpolateMs: 10_000,
      ts: Date.parse('2026-10-23T10:00:00Z'),
      pick: { layerId: 'aircraft', channel: 'aviation.aircraft', ids: ['abc123'] },
    });
  });

  it('groups co-located events into one approximate marker coloured by the worst severity', () => {
    const event = (id: string, severity: 'info' | 'major') => ({
      id,
      source: 'polisen',
      category: 'Brand',
      severity,
      title: id,
      geometry: { type: 'Point' as const, coordinates: [11.9746, 57.7089] },
      locationPrecision: 'municipality' as const,
      start: '2026-10-23T10:00:00Z',
    });
    const items: Record<string, ChannelItem[]> = {
      'events.police': [
        event('a', 'info'),
        event('b', 'major'),
        { ...event('c', 'info'), geometry: undefined, locationPrecision: 'none' as const },
      ],
    };
    const markers = buildMarkers([layer('police')], kinds, (c) => items[c] ?? []);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      icon: 'event',
      color: '#fbbf24',
      label: 'Police events ×2 (approx.)',
      pick: { ids: ['a', 'b'] },
    });
    const inDistrict = {
      ...event('d', 'info'),
      geometry: { type: 'Point' as const, coordinates: [11.9206, 57.6848] },
      locationPrecision: 'district' as const,
      place: 'Kungsladugård',
    };
    const placed = buildMarkers([layer('police')], kinds, () => [inDistrict]);
    expect(placed[0]).toMatchObject({ label: 'Police events ×1, Kungsladugård (approx.)' });
  });

  it('draws nothing for metric channels', () => {
    expect(buildMarkers([layer('weather')], kinds, () => [])).toEqual([]);
  });

  it('colours transit vehicles by line and avoids white line colours', () => {
    const vehicle = (id: string, color: string) => ({
      id,
      source: 'vasttrafik',
      kind: 'tram' as const,
      lon: 11.97,
      lat: 57.7,
      heading: 45,
      label: '1',
      ts: '2026-10-23T10:00:00Z',
      props: { color, textColor: '#006c93', direction: 'Tynnered' },
    });
    const markers = buildMarkers(
      [layer('transit')],
      new Map([['transit.vehicles', 'entities']]),
      () => [vehicle('a', '#d8e8b0'), vehicle('b', '#FFFFFF')],
    );
    expect(markers.map((m) => m.color)).toEqual(['#d8e8b0', '#006c93']);
    expect(markers[0]).toMatchObject({
      icon: 'vehicle',
      heading: 45,
      detect: { code: 'TRAM 1', tag: 'Tynnered' },
      playbackDelayMs: 20_000,
      model: { kind: 'tram', accent: '#d8e8b0' },
    });
    expect(markers[1]?.model?.accent).toBe('#006c93');
  });

  it('sizes ship models from AIS dimensions', () => {
    const ship = (id: string, props: Record<string, unknown>) => ({
      id,
      source: 'aisstream',
      kind: 'ship' as const,
      lon: 11.9,
      lat: 57.69,
      ts: '2026-10-23T10:00:00Z',
      props,
    });
    const markers = buildMarkers(
      [layer('ships')],
      new Map([['maritime.ships', 'entities']]),
      () => [
        ship('a', { category: 'cargo', lengthM: 240, beamM: 30 }),
        ship('b', { category: 'unknown', lengthM: 8 }),
        ship('c', { category: 'passenger' }),
      ],
    );
    expect(markers.map((m) => m.model?.kind)).toEqual(['cargo', 'motorboat', 'passenger']);
    expect(markers[0]?.model?.scale).toEqual([2, 1.5, Math.sqrt(3)]);
    expect(markers[2]?.model?.scale).toEqual([1, 1, 1]);
  });

  it('labels single exact events with their title and keeps dense layers quiet', () => {
    const markers = buildMarkers(
      [layer('road-incidents')],
      new Map([['events.road', 'events']]),
      () => [
        {
          id: 'r1',
          source: 'trafikverket',
          category: 'Vägarbete',
          severity: 'major',
          title: 'Vägarbete: Väg 1937 från Marken till Solåsvägen båda riktningarna',
          geometry: { type: 'Point', coordinates: [12.16, 57.8] },
          locationPrecision: 'exact',
          start: '2026-10-23T10:00:00Z',
        },
      ],
    );
    expect(markers[0]?.label).toBe('Vägarbete: Väg 1937 från Marken till So…');
    expect(markers[0]?.labelMaxDistance).toBe(8_000);
  });
});
