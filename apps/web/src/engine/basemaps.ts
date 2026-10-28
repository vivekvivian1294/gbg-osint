import type { ClientConfig } from '@gbg-osint/shared';
import { Credit, UrlTemplateImageryProvider } from 'cesium';
import type { BasemapId } from '../config';

interface BasemapDef {
  label: string;
  /** Basemaps that need a key are only offered when the server provides one. */
  needsKey?: keyof ClientConfig;
  create(keys: ClientConfig): UrlTemplateImageryProvider;
}

const onScreen = (text: string) => new Credit(text, true);

function carto(style: string, key: string | undefined): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    url: `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(key ?? '')}`,
    subdomains: ['a', 'b', 'c', 'd'],
    maximumLevel: 20,
    credit: onScreen('© OpenStreetMap contributors © CARTO'),
  });
}

// Esri and OSM are keyless; their usage terms apply to whoever runs the tool.
export const BASEMAPS: Record<BasemapId, BasemapDef> = {
  imagery: {
    label: 'Satellite (Esri)',
    create: () =>
      new UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
        credit: onScreen(
          'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        ),
      }),
  },
  dark: {
    label: 'Dark (Esri)',
    create: () =>
      new UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 16,
        credit: onScreen(
          'Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community',
        ),
      }),
  },
  osm: {
    label: 'OpenStreetMap',
    create: () =>
      new UrlTemplateImageryProvider({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maximumLevel: 19,
        credit: onScreen('© OpenStreetMap contributors'),
      }),
  },
  'carto-dark': {
    label: 'Dark Matter (CARTO)',
    needsKey: 'cartoKey',
    create: (keys) => carto('dark_all', keys.cartoKey),
  },
  'carto-voyager': {
    label: 'Voyager (CARTO)',
    needsKey: 'cartoKey',
    create: (keys) => carto('rastertiles/voyager', keys.cartoKey),
  },
};

export function basemapAvailable(id: BasemapId, keys: ClientConfig): boolean {
  const needs = BASEMAPS[id].needsKey;
  return !needs || Boolean(keys[needs]);
}
