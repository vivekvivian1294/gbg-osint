# GBG // OSINT

A live 3D picture of Gothenburg built only from open data: trams, buses, ferries, trains, ships, aircraft and satellites, plus road incidents and cameras, police and crisis events, weather radar, water levels, air quality, district statistics, energy and more, all on one CesiumJS globe.

It is a **research tool you run on your own computer**, not a hosted website. Your copy talks to the public data sources directly, with your own (optional) API keys.

## Quick start

You need [Node.js 24+](https://nodejs.org/).

```sh
git clone https://github.com/vivekvivian1294/gbg-osint.git
cd gbg-osint
npm install
npm start
```

Then open **http://localhost:8787**. `npm start` builds the app and runs it as one process. Stop it with `Ctrl+C`.

### Or with Docker

```sh
docker compose up --build
```

Then open **http://localhost:8787**. Downloaded data (street network, buildings, districts) is kept in a Docker volume between runs.

## API keys (optional)

Everything keyless works out of the box. Keys unlock more layers. Copy `.env.example` to `.env` and fill in the ones you have:

| Variable                                           | Unlocks                                                                        | Register at                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `VASTTRAFIK_CLIENT_ID`, `VASTTRAFIK_CLIENT_SECRET` | Live trams, buses and ferries; departure boards                                | [developer.vasttrafik.se](https://developer.vasttrafik.se/)   |
| `TRAFIKVERKET_API_KEY`                             | Road incidents, road cameras, road weather, traffic flow, trains at Göteborg C | [data.trafikverket.se](https://data.trafikverket.se/)         |
| `GBG_STAD_APP_ID`                                  | City traffic impact and water levels                                           | [goteborg.se/psidata](https://goteborg.se/psidata)            |
| `AISSTREAM_API_KEY`                                | Ships (AIS)                                                                    | [aisstream.io](https://aisstream.io/)                         |
| `SWEDAVIA_FLIGHTINFO_KEY`                          | Landvetter departures and arrivals                                             | [apideveloper.swedavia.se](https://apideveloper.swedavia.se/) |
| `CARTO_API_KEY`                                    | Dark Matter and Voyager basemaps                                               | [carto.com](https://carto.com/)                               |
| `TRAFIKLAB_GTFS_REGIONAL_KEY`                      | Public transport routes and stops (GTFS Regional Static)                       | [trafiklab.se](https://www.trafiklab.se/)                     |
| `CESIUM_ION_ACCESS_TOKEN`                          | 3D terrain and buildings (the `3D` button)                                     | [ion.cesium.com](https://ion.cesium.com/)                     |

Keys stay on your machine: the server uses them, and only the CARTO key and the Cesium ion token are sent to your browser (give the ion token the `assets:read` scope only). Each layer says which key it needs instead of failing silently.

## Using it

- `?` lists the keyboard shortcuts. `/` searches places, live objects, coordinates and street addresses (OpenStreetMap via Photon, looked up only when you ask). `Layers` turns sources on and off, `Feed` shows live events (filter by category, severity, time, what's in view or inside a watch area), `Boards` shows departures, and `Brief` (`N`) gives a "Now in Gothenburg" summary with the transit delay index.
- Click any vehicle, ship or aircraft for details, `T` to track it and `C` to ride along. Ships, aircraft and trains show where they have been in the last 24 hours. Cards can show the nearest road camera.
- Right-click the map (long-press on touch, or `W` for the centre) for "What's here?": nearby incidents, the nearest road camera, street-level photos, Wikipedia articles and district statistics.
- `G` opens the tools: measure, pins, routes (with "Fly the route") and watch areas. A watch area alerts you when an incident appears inside it or a ship or train enters, while the app is open.
- Under _Layers › Environment_ you can add animated wind, yesterday's satellite image, citizen air sensors, bathing-water quality and (in season) the pollen forecast.
- Hover the metrics strip, or open a sensor card, for 24-hour sparklines. The server keeps this history in its cache directory, so it survives restarts; it fills up while the server runs.
- `S` plays camera tours, records your own and saves or opens them as files to share. `E` exports the selection or the view as GeoJSON or CSV, or saves a screenshot with credits. `1`–`6` switch the optics styles.
- The URL keeps the camera, layers and tracked object, so links reopen the same view on your own copy.

## Responsible use

- **No people tracking.** The tool shows vehicles, events, infrastructure and systems. It has no person search, no face recognition and no profiling. Camera and street-level images are only displayed.
- **Estimates are labelled.** Vehicle motion between updates, camera viewsheds and approximate event locations are modelled, and the app marks them as such. Police events are only located to the municipality.
- **Respect the sources.** Every source is credited in the app. Their terms of use and rate limits apply to you when you run the tool; please don't remove the throttling or point heavy automated use at community services (OSRM, Nominatim, OpenFreeMap). Setting `UPSTREAM_USER_AGENT` to include your e-mail is good practice.
- **Keep it local.** The server listens on `127.0.0.1` only. Don't expose it to the internet.

## Development

```sh
npm run dev        # web on http://localhost:5173 (hot reload), API on :8787
npm test           # unit tests (vitest)
npm run typecheck && npm run lint && npm run format:check
```

- `apps/server`: Fastify server, scheduler and one connector per source (`src/connectors/`). It serves the built web app too.
- `apps/web`: React + CesiumJS app (`src/engine/` for the 3D engine, `src/layers/` for the layer registry).
- `packages/shared`: zod schemas for the normalized model (entities, events, metrics and more).

[PLAN.md](PLAN.md) has the architecture, the data source catalogue and the roadmap.

## Licence

The code is MIT licensed (see [LICENSE](LICENSE)). The data belongs to its providers and is shown under their own terms and licences, which the app lists with each source.
