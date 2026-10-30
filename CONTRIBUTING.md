# Contributing

Thanks for helping. GBG // OSINT is a local research tool that puts Gothenburg's open data on one 3D map. Contributions that add sources, improve how data is shown or make the tool easier to run are welcome.

Please read [Responsible use](README.md#responsible-use) first. In short: the tool is about vehicles, events, infrastructure and systems. It does not track, search for or profile people. Sources and features that would do that won't be accepted.

## Set up

You need [Node.js 24+](https://nodejs.org/).

```sh
npm install
cp .env.example .env   # optional: add the keys you have
npm run dev            # web on http://localhost:5173 (hot reload), API on :8787
```

Before you open a pull request, run what CI runs:

```sh
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```

`npm run format` fixes formatting. CI also runs `npm audit --audit-level=high` and builds the Docker image.

## How it fits together

- `packages/shared`: zod schemas for the normalized model (entities, events, metrics, departures, features, frames, areas) and the WebSocket protocol.
- `apps/server`: one **connector** per source in `src/connectors/`. The scheduler runs them, validates what they publish and sends it to browsers over WebSocket channels such as `transit.vehicles` or `events.police`.
- `apps/web`: the React + CesiumJS app. `src/layers/registry.ts` lists the layers, `src/layers/markers.ts` styles map markers and `src/engine/` draws everything on the globe.

[PLAN.md](PLAN.md) has the architecture, the source catalogue and the roadmap.

Phase 9, an optional voice and AI analyst (each user brings their own AI key), is left for the community to build. Open an issue to discuss the design before you start.

## Adding a data source

### 1. Check the source

- **Licence and terms:** it must be open data, or have terms that allow this use. Note the licence and how to credit it.
- **Rate limits:** find out how often you may call it. Community services (OSRM, Nominatim, OpenFreeMap, Photon) need gentle use and caching.
- **Keys:** keyless is best. If a key is needed, it must be free to register.
- **People:** the data should describe systems, not individuals. Coarsen positions if the source is precise about private things (citizen sensors are rounded to about 100 m, for example).

Add the source to the catalogue in [PLAN.md](PLAN.md#4-data-source-catalogue).

### 2. Choose a channel

A channel has a lower-case, dot-separated name (`env.air-quality-community`) and a kind. The kind decides the schema in [`packages/shared/src/model.ts`](packages/shared/src/model.ts):

| Kind         | For                                                        | Drawn as                |
| ------------ | ---------------------------------------------------------- | ----------------------- |
| `entities`   | things with a position: vehicles, stations, sensors        | markers (and 3D models) |
| `events`     | incidents, warnings, news, with an optional geometry       | markers and the feed    |
| `metrics`    | single values such as a temperature or a price             | the metrics strip       |
| `departures` | departure and arrival boards                               | the Boards panel        |
| `features`   | lines such as rivers or road stretches (encoded polylines) | lines on the ground     |
| `areas`      | polygons with figures, such as districts                   | filled areas            |
| `frames`     | raster images over a bounding box, such as radar           | image overlays          |

### 3. Write the connector

Create `apps/server/src/connectors/<source>.ts`. Keep the parsing in a **pure function** so it can be tested without the network:

```ts
import type { Entity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';

const HOST = 'api.example.se';
const CHANNEL = 'env.noise';

const Station = z.object({
  id: z.string().max(40),
  name: z.string().max(120),
  lon: z.number(),
  lat: z.number(),
  levelDb: z.number().min(0).max(150),
  time: z.string(),
});

/** Upstream JSON in, valid entities out; anything malformed is skipped. */
export function parseNoise(raw: unknown): Entity[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const s = Station.safeParse(item);
    const ts = s.success ? Date.parse(s.data.time) : NaN;
    if (!s.success || !Number.isFinite(ts)) return [];
    return [
      {
        id: `noise-${s.data.id}`,
        source: 'example.noise',
        kind: 'sensor',
        lon: s.data.lon,
        lat: s.data.lat,
        label: s.data.name,
        ts: new Date(ts).toISOString(),
        props: { levelDb: s.data.levelDb },
      },
    ];
  });
}

export const exampleNoise: PollConnector = {
  id: 'example.noise',
  name: 'Example City – noise sensors',
  licence: 'CC0 1.0',
  attribution: 'Example City',
  homepage: 'https://example.se/open-data',
  mode: 'poll',
  intervalMs: 10 * 60_000,
  allowedHosts: [HOST],
  requiredEnv: ['EXAMPLE_API_KEY'],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    const raw = await ctx.http.getJson(`https://${HOST}/v1/noise`, {
      headers: { 'x-api-key': ctx.env.EXAMPLE_API_KEY! },
    });
    ctx.publish.replace(CHANNEL, parseNoise(raw));
  },
};
```

Then add it to the list in [`apps/server/src/connectors/index.ts`](apps/server/src/connectors/index.ts).

The rules the server enforces, and the ones it relies on you for:

- **HTTP:** use `ctx.http` only. It allows HTTPS to the hosts in `allowedHosts` (redirect targets included) and applies a timeout and a size cap. List every host the connector calls.
- **Validation:** treat upstream data as untrusted. Parse it with zod, cap string lengths and drop what doesn't fit. Published items are validated again against the channel schema, and invalid ones are logged and dropped.
- **Modes:** `poll` runs `poll(ctx)` every `intervalMs`. `stream` keeps a connection open in `run(ctx)` and is reconnected with backoff. `on-demand` answers browser requests in `serve(ctx, path)` under `/api/data/<id>/<path>`.
- **Publishing:** `replace(channel, items)` publishes the full current set. `apply(channel, upserts, removeIds)` sends changes, which suits streams.
- **On-demand paths:** these come from the browser. Match them against a strict regular expression, check value ranges (for example, inside the Gothenburg area), and return `undefined` for anything else. Throttle and cache upstream calls (see `routing.ts`, `wikipedia.ts` or `geocoder.ts`).
- **Keys:** list them in `requiredEnv` or `optionalEnv`. `ctx.env` contains only those variables. A source with a missing key shows "Needs key" instead of failing. Never log or publish a key, and never put one in a URL that reaches the browser.
- **Big or slow downloads:** keep them in `ctx.cache` (keys match `[a-z0-9_-]{1,64}`), so restarts don't download again.
- **Errors:** throw `UpstreamError` for messages that are safe to show to users. Other errors are logged on the server only.

### 4. Test it

Add tests next to the connector (`apps/server/src/connectors/*.test.ts`). Give the pure parser a small, hand-written fixture that covers good items, malformed items and edge cases. Tests must not call the network.

To try a real API while developing, put a throwaway script in `apps/server/` (for example `probe.mts`), run it with `npx tsx apps/server/probe.mts`, and delete it before you commit. Don't commit real responses that contain personal data, or any keys.

### 5. Show it on the map

- **Layer:** add a `LayerDef` to [`apps/web/src/layers/registry.ts`](apps/web/src/layers/registry.ts) with an `id`, a `label`, a `group`, the connector id in `sourceIds`, your `channels` and the roadmap `phase`. Use `note` for caveats readers need, such as "indicative only".
- **Entities:** add an `EntityStyle` under the same layer id in `ENTITY_STYLES` in [`apps/web/src/layers/markers.ts`](apps/web/src/layers/markers.ts) to set the icon, colour, label and the distance at which labels appear.
- **Events and metrics:** these appear on the map, in the feed and in the metrics strip without extra code.
- **Features, areas and frames:** these need a drawing layer in `apps/web/src/engine/`. Look at `waterways.ts`, `districts.ts` or `radar.ts`.

Run `npm run dev`, switch the layer on and open the source status (the **Live** button at the right of the top bar) to see the source's state and last update.

### 6. Document it

- If the source needs a key, add an empty line for it to `.env.example` and a row to the key table in [README.md](README.md#api-keys-optional).
- Mention new features under "Using it" in the README if users will look for them.

## Pull requests

- Keep each pull request to one source or feature, with tests.
- In the description, say what the source's licence and rate limits are, and whether it needs a key.
- Add a screenshot for visible changes.
- Write clear, plain English in the UI. Swedish place and source names stay as they are.

## Reporting security problems

Please don't put details of a vulnerability in a public issue. Use GitHub's private vulnerability reporting on the repository (Security › Report a vulnerability). If that isn't available, open an issue asking for a private contact.
