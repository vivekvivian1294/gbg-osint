import { describe, expect, it } from 'vitest';
import { parsePhoton, parseSearchPath } from './geocoder';

const path = (text: string) => `search/${Buffer.from(text, 'utf8').toString('base64url')}.json`;

describe('address search (Photon)', () => {
  it('accepts canonical base64url queries of sensible length', () => {
    expect(parseSearchPath(path('Kungsportsavenyen 10'))).toBe('Kungsportsavenyen 10');
    expect(parseSearchPath(path('  Järntorget\t'))).toBe('Järntorget');
    expect(parseSearchPath(path('ab'))).toBeUndefined();
    expect(parseSearchPath(path('x'.repeat(61)))).toBeUndefined();
    expect(parseSearchPath(path('a\u0000bc'))).toBeUndefined();
    expect(parseSearchPath('search/not base64.json')).toBeUndefined();
    // Padded or otherwise non-canonical encodings are refused.
    expect(parseSearchPath(`${path('Avenyn').slice(0, -5)}=.json`)).toBeUndefined();
    expect(parseSearchPath('route/abc.json')).toBeUndefined();
  });

  it('turns Photon features into labelled results without duplicates', () => {
    const feature = (properties: Record<string, unknown>, lon = 11.974, lat = 57.7014) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    });
    const raw = {
      features: [
        feature({
          osm_value: 'house',
          street: 'Kungsportsavenyen',
          housenumber: '10',
          district: 'Vasastaden',
          city: 'Göteborg',
        }),
        feature({
          osm_value: 'house',
          street: 'Kungsportsavenyen',
          housenumber: '10',
          district: 'Vasastaden',
          city: 'Göteborg',
        }),
        feature(
          {
            osm_value: 'restaurant',
            name: 'Hard Rock Cafe',
            street: 'Kungsportsavenyen',
            housenumber: '10',
            district: 'Vasastaden',
            city: 'Göteborg',
          },
          11.97425,
          57.70123,
        ),
        feature({ city: 'Göteborg', osm_value: 'city' }, 11.97, 57.71),
        { geometry: { type: 'LineString', coordinates: [] }, properties: {} },
        feature({ osm_value: 'yes' }),
      ],
    };
    expect(parsePhoton(raw).results).toEqual([
      {
        label: 'Kungsportsavenyen 10',
        detail: 'Vasastaden, Göteborg',
        kind: 'house',
        lon: 11.974,
        lat: 57.7014,
      },
      {
        label: 'Hard Rock Cafe',
        detail: 'Kungsportsavenyen 10, Vasastaden, Göteborg',
        kind: 'restaurant',
        lon: 11.97425,
        lat: 57.70123,
      },
      { label: 'Göteborg', kind: 'city', lon: 11.97, lat: 57.71 },
    ]);
  });
});
