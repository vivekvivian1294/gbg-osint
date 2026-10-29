import type { ChannelItem, ChannelKind, Entity } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../engine/path';
import { flowRatio, offsetLine, travelTimeColor } from '../engine/travelTimes';
import { buildMarkers, FLIGHT_CATEGORY_COLORS } from './markers';
import { LAYER_BY_ID, type LayerDef } from './registry';

const train = (id: string, source: string, props: Record<string, unknown> = {}): Entity => ({
  id,
  source,
  kind: 'train',
  lon: 11.97,
  lat: 57.71,
  heading: 90,
  label: id,
  ts: '2026-10-29T08:00:00.000Z',
  props,
});

describe('travel times', () => {
  it('colours stretches by status, or by speed against free flow', () => {
    expect(travelTimeColor({ status: 'congested' })).toBe('#f87171');
    expect(travelTimeColor({ travelTimeS: 100, freeFlowS: 95 })).toBe('#4ade80');
    expect(travelTimeColor({ travelTimeS: 180, freeFlowS: 95 })).toBe('#fb923c');
    expect(travelTimeColor({})).toBe('#94a3b8');
    expect(flowRatio({ travelTimeS: 200, freeFlowS: 100 })).toBe(0.5);
    expect(flowRatio({ travelTimeS: 80, freeFlowS: 100 })).toBe(1);
  });

  it('draws each direction to the right of its travel', () => {
    const frame = new LocalFrame(11.97, 57.7);
    const east = [frame.toLonLat(0, 0), frame.toLonLat(100, 0)];
    for (const [lon, lat] of offsetLine(east, 6)) {
      expect(frame.toXY(lon, lat)[1]).toBeCloseTo(-6, 3);
    }
    const west = [frame.toLonLat(100, 0), frame.toLonLat(0, 0)];
    for (const [lon, lat] of offsetLine(west, 6)) {
      expect(frame.toXY(lon, lat)[1]).toBeCloseTo(6, 3);
    }
  });
});

describe('Phase 6.1 markers', () => {
  const kinds = new Map<string, ChannelKind>([
    ['transit.vehicles', 'entities'],
    ['transit.rail', 'entities'],
    ['aviation.metar', 'entities'],
  ]);
  const layers = ['transit', 'rail', 'airport-weather'].map((id) => LAYER_BY_ID.get(id)!);
  const items: Record<string, ChannelItem[]> = {
    'transit.vehicles': [
      { ...train('vt-train', 'vasttrafik'), label: 'Västtåg' },
      { ...train('tram-1', 'vasttrafik'), kind: 'tram' },
    ],
    'transit.rail': [train('3979', 'trafikverket', { delayMin: 18, destination: 'Göteborg C' })],
    'aviation.metar': [
      {
        ...train('ESGG', 'aviationweather', { flightCategory: 'IFR' }),
        kind: 'sensor',
      },
    ],
  };
  const itemsOf = (channel: string) => items[channel] ?? [];

  it('shows live trains with a 3D model and delay colour, and drops duplicates', () => {
    const markers = buildMarkers(layers, kinds, itemsOf);
    const keys = markers.map((m) => m.pick.ids[0]);
    expect(keys).toEqual(['tram-1', '3979', 'ESGG']);
    const rail = markers.find((m) => m.pick.layerId === 'rail')!;
    expect(rail).toMatchObject({
      color: '#f87171',
      model: { kind: 'train' },
      detect: { code: 'TRAIN 3979', tag: '+18 min' },
    });
    expect(rail.playbackDelayMs).toBeGreaterThan(0);
    const metar = markers.find((m) => m.pick.layerId === 'airport-weather')!;
    expect(metar.color).toBe(FLIGHT_CATEGORY_COLORS.IFR);
  });

  it('keeps Västtrafik trains when live rail positions are off or empty', () => {
    const withoutRail: LayerDef[] = [LAYER_BY_ID.get('transit')!];
    expect(buildMarkers(withoutRail, kinds, itemsOf)).toHaveLength(2);
    const empty = (channel: string) => (channel === 'transit.rail' ? [] : itemsOf(channel));
    expect(buildMarkers(layers, kinds, empty).map((m) => m.pick.ids[0])).toContain('vt-train');
  });
});
