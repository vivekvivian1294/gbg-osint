export const BASEMAP_IDS = ['imagery', 'dark', 'osm', 'carto-dark', 'carto-voyager'] as const;
export type BasemapId = (typeof BASEMAP_IDS)[number];
export const DEFAULT_BASEMAP: BasemapId = 'imagery';

/** Sensor-style looks, in keyboard order (keys 1–6). */
export const STYLE_IDS = ['normal', 'crt', 'nvg', 'flir', 'ironbow', 'noir'] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export const STYLE_LABELS: Record<StyleId, string> = {
  normal: 'Normal',
  crt: 'CRT',
  nvg: 'Night vision',
  flir: 'Thermal (white-hot)',
  ironbow: 'Thermal (ironbow)',
  noir: 'Noir',
};

export const CATALOG_POLL_MS = 15_000;
