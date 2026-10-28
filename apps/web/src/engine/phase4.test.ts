import { describe, expect, it, vi } from 'vitest';
import { parseHash, serializeHash } from '../state/urlState';
import { photoTilesFor } from '../state/streetPhotos';
import { addKeyframe, recordedTour, TOURS } from '../tours';
import { buildingColor } from './buildings';
import { lonLatOfTile, tileOf, tilesAround } from './tiles';
import { orbit, sampleTour, tourDuration, TourPlayer, type TourKeyframe } from './tours';
import { cabMount } from './tracker';
import { MODELS } from './vehicleModels';
import { viewWedge, VIEW_RANGE_M } from './viewsheds';

const view = (lon: number, lat: number, height: number, heading = 0, pitch = -30) => ({
  lon,
  lat,
  height,
  heading,
  pitch,
});

describe('tiles', () => {
  it('converts between lon/lat and tile coordinates', () => {
    const [x, y] = tileOf(11.9746, 57.7089, 14);
    expect(Math.floor(x)).toBe(8736);
    expect(Math.floor(y)).toBe(4959);
    const [lon, lat] = lonLatOfTile(x, y, 14);
    expect(lon).toBeCloseTo(11.9746, 9);
    expect(lat).toBeCloseTo(57.7089, 9);
  });

  it('lists nearby tiles nearest first, capped', () => {
    const tiles = tilesAround(11.9746, 57.7089, 2_000, 14, 12);
    expect(tiles[0]).toMatchObject({ x: 8736, y: 4959 });
    expect(tiles.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i]!.distanceM).toBeGreaterThanOrEqual(tiles[i - 1]!.distanceM);
    }
    expect(tilesAround(11.9746, 57.7089, 100, 14, 50).length).toBeLessThan(5);
  });

  it('only loads street photos when zoomed in', () => {
    expect(photoTilesFor(view(11.97, 57.7, 10_000))).toEqual([]);
    const near = photoTilesFor(view(11.97, 57.7, 500));
    const [x, y] = tileOf(11.97, 57.7, 15).map(Math.floor);
    expect(near[0]).toBe(`${x}/${y}`);
    expect(near.length).toBeLessThanOrEqual(16);
  });
});

describe('camera tours', () => {
  const frames: TourKeyframe[] = [
    { at: 0, camera: view(11.9, 57.7, 400, 350) },
    { at: 10, camera: view(12.0, 57.7, 200, 10) },
    { at: 20, camera: view(12.1, 57.8, 400, 30) },
  ];

  it('passes through every keyframe and clamps outside the tour', () => {
    expect(sampleTour(frames, -5)).toEqual(frames[0]!.camera);
    expect(sampleTour(frames, 10)).toMatchObject({ lon: 12.0, height: 200, heading: 10 });
    expect(sampleTour(frames, 99)).toEqual(frames[2]!.camera);
    expect(tourDuration({ keyframes: frames })).toBe(20);
  });

  it('turns the short way round and eases in from rest', () => {
    const headings = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((t) => sampleTour(frames, t).heading);
    for (const h of headings) expect(h < 15 || h > 345).toBe(true);
    const step1 = sampleTour(frames, 0.5).lon - frames[0]!.camera.lon;
    const step2 = sampleTour(frames, 1).lon - sampleTour(frames, 0.5).lon;
    expect(step1).toBeGreaterThan(0);
    expect(step2).toBeGreaterThan(step1);
  });

  it('builds orbits that close the circle and look at the centre', () => {
    const keyframes = orbit(11.9667, 57.7071, 700, 380, 80, 8);
    expect(keyframes).toHaveLength(9);
    const first = keyframes[0]!.camera;
    const last = keyframes.at(-1)!.camera;
    expect(last.lon).toBeCloseTo(first.lon, 9);
    expect(last.lat).toBeCloseTo(first.lat, 9);
    expect(first.lat).toBeLessThan(57.7071);
    expect(first.heading).toBeCloseTo(0, 9);
    expect(first.pitch).toBeCloseTo(-28.5, 1);
  });

  it('plays a tour to the end and reports progress', () => {
    const onChange = vi.fn();
    const player = new TourPlayer(onChange);
    player.play({ id: 't', title: 'Test', summary: '', keyframes: frames }, 1_000);
    expect(player.frame(1_000)).toEqual(frames[0]!.camera);
    expect(onChange).toHaveBeenLastCalledWith({ id: 't', title: 'Test', elapsed: 0, duration: 20 });
    expect(player.frame(21_000)).toEqual(frames[2]!.camera);
    expect(player.playing).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(player.frame(22_000)).toBeUndefined();
  });

  it('has well-formed Gothenburg tours and records evenly spaced views', () => {
    for (const tour of TOURS) {
      expect(tour.keyframes.length).toBeGreaterThan(2);
      const times = tour.keyframes.map((k) => k.at);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(tourDuration(tour)).toBeGreaterThan(30);
    }
    let rec: TourKeyframe[] = [];
    for (let i = 0; i < 35; i++) rec = addKeyframe(rec, view(11.9 + i * 0.001, 57.7, 300));
    expect(rec).toHaveLength(30);
    expect(rec.map((k) => k.at).slice(0, 3)).toEqual([0, 8, 16]);
    expect(rec[0]!.camera.lon).toBeCloseTo(11.905, 9);
    expect(recordedTour(rec)).toMatchObject({ id: 'recorded', keyframes: rec });
  });
});

describe('ride-along', () => {
  it('puts the eye just past the front of the vehicle', () => {
    const tram = cabMount({ icon: 'vehicle', model: { kind: 'tram', accent: '#fff', range: 1 } });
    expect(tram.forward).toBeGreaterThan(MODELS.tram.length / 2);
    const ship = cabMount({
      icon: 'ship',
      model: { kind: 'cargo', accent: '#fff', range: 1, scale: [2, 2, 2] },
    });
    expect(ship.forward).toBeCloseTo(MODELS.cargo.length + 1, 9);
    expect(ship.up).toBeGreaterThan(20);
    expect(cabMount({ icon: 'aircraft' }).pitchDeg).toBeLessThan(0);
  });

  it('keeps ride-along in share links only while tracking', () => {
    const state = { track: { layerId: 'transit', id: 'abc' }, ride: true };
    expect(serializeHash(state)).toBe('track=transit:abc&ride=1');
    expect(parseHash('#track=transit:abc&ride=1')).toMatchObject({ ride: true });
    expect(parseHash('#ride=1').ride).toBeUndefined();
  });
});

describe('estimated camera views and buildings', () => {
  it('draws a wedge from the camera around its direction', () => {
    const wedge = viewWedge({ id: 'c', lon: 11.97, lat: 57.71, heading: 90 });
    expect(wedge.slice(0, 2)).toEqual([11.97, 57.71]);
    // The apex, then 11 arc points; the middle one (index 5) lies straight along the heading.
    const [lon, lat] = [wedge[2 + 2 * 5]!, wedge[3 + 2 * 5]!];
    expect(lat).toBeCloseTo(57.71, 6);
    const metresEast = (lon - 11.97) * 111_320 * Math.cos((57.71 * Math.PI) / 180);
    expect(metresEast).toBeCloseTo(VIEW_RANGE_M, 0);
  });

  it('colours taller buildings lighter', () => {
    const low = buildingColor(3);
    const high = buildingColor(120);
    expect(high.red + high.green + high.blue).toBeGreaterThan(low.red + low.green + low.blue);
    expect(buildingColor(27).blue).toBeGreaterThan(low.blue);
  });
});
