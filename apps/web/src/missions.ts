import { GOTHENBURG } from '@gbg-osint/shared';
import type { BasemapId, StyleId } from './config';
import { homeCamera, viewOf, type CameraState } from './engine/cameraState';

export interface Mission {
  id: string;
  title: string;
  summary: string;
  layers: readonly string[];
  basemap: BasemapId;
  style: StyleId;
  hud: boolean;
  detection: boolean;
  camera: CameraState;
}

export const MISSIONS: readonly Mission[] = [
  {
    id: 'city-pulse',
    title: 'City pulse',
    summary:
      'Trams, buses and ferries live, police, crisis and news feeds over central Gothenburg.',
    layers: [
      'transit',
      'police',
      'crisis',
      'weather-warnings',
      'news',
      'road-incidents',
      'poi',
      'weather',
      'air-quality',
      'electricity',
      'departures',
      'trains',
    ],
    basemap: 'imagery',
    style: 'normal',
    hud: false,
    detection: false,
    camera: homeCamera(),
  },
  {
    id: 'sky-watch',
    title: 'Sky watch',
    summary:
      'Aircraft around the region and satellites currently above Gothenburg, in night vision.',
    layers: ['aircraft', 'satellites', 'weather'],
    basemap: 'dark',
    style: 'nvg',
    hud: true,
    detection: true,
    camera: viewOf(GOTHENBURG.center.lon, GOTHENBURG.center.lat, 900_000, -55),
  },
  {
    id: 'approach-got',
    title: 'Approach GOT',
    summary:
      'Traffic around Landvetter Airport through a white-hot thermal look, with the flight board.',
    layers: ['aircraft', 'weather', 'flights'],
    basemap: 'imagery',
    style: 'flir',
    hud: true,
    detection: true,
    camera: viewOf(12.2794, 57.6628, 12_000, -30),
  },
  {
    id: 'storm-watch',
    title: 'Storm watch',
    summary: 'SMHI warnings, forecast, sea, river and road-surface conditions over the harbour.',
    layers: [
      'weather-warnings',
      'crisis',
      'weather',
      'rain-nowcast',
      'wind',
      'harbour-stations',
      'sea-level',
      'water-levels',
      'road-weather',
      'news',
    ],
    basemap: 'imagery',
    style: 'noir',
    hud: true,
    detection: false,
    camera: viewOf(11.8, 57.68, 25_000, -40),
  },
  {
    id: 'harbour-watch',
    title: 'Harbour watch',
    summary:
      'Port of Gothenburg and the river mouth: AIS ships and arrivals, ferries, wind, currents and water levels.',
    layers: [
      'ships',
      'expected-ships',
      'transit',
      'ferries',
      'harbour-stations',
      'sea-level',
      'water-levels',
      'poi',
      'weather',
    ],
    basemap: 'imagery',
    style: 'crt',
    hud: true,
    detection: false,
    camera: viewOf(11.86, 57.69, 6_000, -30),
  },
];
