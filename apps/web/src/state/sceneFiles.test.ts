import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tour } from '../engine/tours';
import { slug } from './download';
import {
  loadImportedTours,
  parseSceneFile,
  saveImportedTours,
  sceneFile,
  SCENE_FORMAT,
} from './sceneFiles';

const tour: Tour = {
  id: 'recorded',
  title: 'Your tour',
  summary: '2 recorded views',
  keyframes: [
    {
      at: 0,
      camera: { lon: 11.9667123456, lat: 57.7071, height: 400.04, heading: 10, pitch: -30 },
    },
    { at: 8, camera: { lon: 11.98, lat: 57.71, height: 300, heading: 350.123, pitch: -25 } },
  ],
};

const file = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(sceneFile(tour)), ...patch });

describe('scene files', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a tour with its layers, rounded to sensible precision', () => {
    const text = sceneFile(tour, ['buildings', 'transit']);
    expect(JSON.parse(text)).toMatchObject({ format: SCENE_FORMAT, version: 1 });
    const back = parseSceneFile(text, 'file-abc');
    expect(back).toMatchObject({
      id: 'file-abc',
      title: 'Your tour',
      layers: ['buildings', 'transit'],
    });
    expect(back.keyframes[0]!.camera.lon).toBe(11.966712);
    expect(back.keyframes[0]!.camera.height).toBe(400);
    expect(back.keyframes[1]!.camera.heading).toBe(350.12);
  });

  it('explains what is wrong with a file', () => {
    expect(() => parseSceneFile('{nope')).toThrow('not valid JSON');
    expect(() => parseSceneFile('{"type":"FeatureCollection"}')).toThrow('not a GBG OSINT tour');
    expect(() => parseSceneFile(file({ version: 2 }))).toThrow('(version)');
    expect(() =>
      parseSceneFile(file({ keyframes: [tour.keyframes[1], tour.keyframes[0]] })),
    ).toThrow('Keyframe times must increase');
    const far = { at: 9, camera: { ...tour.keyframes[0]!.camera, lat: 123 } };
    expect(() => parseSceneFile(file({ keyframes: [...tour.keyframes, far] }))).toThrow(
      '(keyframes.2.camera.lat)',
    );
    expect(() => parseSceneFile(file({ layers: ['<script>'] }))).toThrow('(layers.0)');
    expect(() => parseSceneFile(' '.repeat(300_000))).toThrow('too large');
  });

  it('keeps opened tours in the browser and drops tampered entries', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    const opened = parseSceneFile(sceneFile(tour), 'file-x1');
    saveImportedTours([opened]);
    const saved = JSON.parse(store.get('gbg-osint:scenes')!) as unknown[];
    store.set(
      'gbg-osint:scenes',
      JSON.stringify([...saved, { id: 'file-x2', file: { format: 'x' } }]),
    );
    expect(loadImportedTours()).toEqual([opened]);
  });

  it('makes file-name-safe slugs', () => {
    expect(slug('Bike ride · 2,85 km')).toBe('bike-ride-2-85-km');
    expect(slug('Göta älv från havet')).toBe('gota-alv-fran-havet');
    expect(slug('···', 'tour')).toBe('tour');
  });
});
