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

Keys stay on your machine: the server uses them, and only the CARTO basemap key is sent to your browser. Each layer says which key it needs instead of failing silently.

## Using it

- `?` lists the keyboard shortcuts. `Layers` turns sources on and off, `Feed` shows live events, `Boards` shows departures.
- Click any vehicle, ship or aircraft for details, `T` to track it and `C` to ride along.
- `S` plays camera tours, `G` opens the tools (measure, pins, routes). `1`–`6` switch the optics styles.
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
