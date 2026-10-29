import type { ChannelItem, ChannelKind, Entity, Feature } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../engine/path';
import { flowRatio, offsetLine, travelTimeColor } from '../engine/travelTimes';
import { buildMarkers, FLIGHT_CATEGORY_COLORS, lineKey, MODE_COLORS, routeColor } from './markers';
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

describe('public transport routes and stops', () => {
  const route = (mode: string, line: string): Feature => ({
    id: `${mode}-${line}`,
    source: 'trafiklab',
    kind: 'transit-route',
    line: '_p~iF~ps|U_ulLnnqC',
    ts: '2026-10-29T08:00:00.000Z',
    props: { mode, line },
  });

  it('uses the live line colour when known, else the mode colour', () => {
    const colors = new Map([[lineKey('TRAM', '6'), '#f59e0b']]);
    expect(routeColor(route('tram', '6'), colors)).toBe('#f59e0b');
    expect(routeColor(route('tram', '7'), colors)).toBe(MODE_COLORS.tram);
    expect(routeColor(route('bus', '6'), colors)).toBe(MODE_COLORS.bus);
    expect(routeColor(route('cable car', '1'), colors)).toBe('#94a3b8');
  });

  it('colours stops by their most significant mode', () => {
    const stop = (modes: string): Entity => ({
      id: modes,
      source: 'trafiklab',
      kind: 'poi',
      lon: 11.97,
      lat: 57.7,
      label: 'Brunnsparken',
      ts: '2026-10-29T08:00:00.000Z',
      props: { lines: 'Tram 6', modes },
    });
    const markers = buildMarkers(
      [LAYER_BY_ID.get('transit-stops')!],
      new Map<string, ChannelKind>([['transit.stops', 'entities']]),
      () => [stop('tram,bus'), stop('bus'), stop('')],
    );
    expect(markers.map((m) => m.color)).toEqual([MODE_COLORS.tram, MODE_COLORS.bus, '#94a3b8']);
  });
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

describe('harbour stations', () => {
  const station = (id: string, props: Record<string, unknown>): Entity => ({
    id,
    source: 'viva',
    kind: 'sensor',
    lon: 11.79,
    lat: 57.68,
    label: id,
    ts: '2026-10-29T00:30:00.000Z',
    props,
  });
  const harbour = LAYER_BY_ID.get('harbour-stations')!;
  const kinds = new Map<string, ChannelKind>([['env.harbour', 'entities']]);
  const markersFor = (...stations: Entity[]) =>
    buildMarkers([harbour], kinds, (c) => (c === 'env.harbour' ? stations : []));

  it('labels wind (gusts) or water level and colours by gust strength', () => {
    const [windy, calm, level] = markersFor(
      station('Torshamnen', { windMs: 9.7, gustMs: 18 }),
      station('Vinga', { windMs: 4, gustMs: 6 }),
      station('Tångudden', { waterLevelCm: -12 }),
    );
    expect(windy).toMatchObject({ label: 'Torshamnen 10(18) m/s', color: '#f87171' });
    expect(calm!.color).toBe('#5eead4');
    expect(level).toMatchObject({ label: 'Tångudden -12 cm', color: '#22d3ee' });
  });
});
