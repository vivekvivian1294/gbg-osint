import { GOTHENBURG, type Entity } from '@gbg-osint/shared';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { StreamConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { normalizeHeading, truncate } from './util';

const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const SHIPS = 'maritime.ships';
const PUBLISH_MS = 5_000;
/** Reconnect when the stream goes quiet; the harbour always has some AIS traffic. */
const SILENCE_MS = 3 * 60_000;
const POSITION_MAX_AGE_MS = 20 * 60_000;
const STATIC_MAX_AGE_MS = 12 * 3600_000;
const MAX_VESSELS = 3000;
const KNOTS_TO_MS = 0.514444;
const MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

const Meta = z.object({
  MMSI: z.number().int().positive(),
  ShipName: z.string().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  time_utc: z.string(),
});
const Envelope = z.object({
  MessageType: z.string(),
  MetaData: Meta.optional(),
  Message: z.record(z.string(), z.unknown()).optional(),
});
const PositionBody = z.object({
  Cog: z.number().optional(),
  Sog: z.number().optional(),
  TrueHeading: z.number().optional(),
  NavigationalStatus: z.number().optional(),
});
const Dimension = z.object({
  A: z.number(),
  B: z.number(),
  C: z.number().optional(),
  D: z.number().optional(),
});
const ShipStatic = z.object({
  Name: z.string().optional(),
  CallSign: z.string().optional(),
  Type: z.number().optional(),
  Destination: z.string().optional(),
  Dimension: Dimension.optional(),
});
const ClassBStatic = z.object({
  ReportA: z.object({ Valid: z.boolean().optional(), Name: z.string().optional() }).optional(),
  ReportB: z
    .object({
      Valid: z.boolean().optional(),
      ShipType: z.number().optional(),
      CallSign: z.string().optional(),
      Dimension: Dimension.optional(),
    })
    .optional(),
});

interface Position {
  lon: number;
  lat: number;
  ts: number;
  cog?: number;
  sog?: number;
  heading?: number;
  navStatus?: number;
  classB: boolean;
}

interface Static {
  ts: number;
  name?: string;
  callsign?: string;
  type?: number;
  destination?: string;
  lengthM?: number;
  beamM?: number;
}

export interface AisState {
  positions: Map<number, Position>;
  statics: Map<number, Static>;
}

export function createAisState(): AisState {
  return { positions: new Map(), statics: new Map() };
}

/** `2026-10-23 12:24:06.230068183 +0000 UTC` → epoch ms. */
export function parseAisTime(value: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d* \+0000/.exec(value);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

const clean = (s: string | undefined) => s?.replace(/@+$/, '').trim() || undefined;

/** Hull length and beam from the AIS reference-point offsets; zeros mean "not available". */
function dimensions(d: z.infer<typeof Dimension> | undefined): Pick<Static, 'lengthM' | 'beamM'> {
  if (!d) return {};
  const length = d.A + d.B;
  const beam = (d.C ?? 0) + (d.D ?? 0);
  return {
    ...(length > 0 && length < 500 && { lengthM: length }),
    ...(beam > 0 && beam < 80 && { beamM: beam }),
  };
}

export function applyAisMessage(state: AisState, raw: unknown): void {
  const env = Envelope.safeParse(raw);
  if (!env.success || !env.data.MetaData || !env.data.Message) return;
  const { MessageType: type, MetaData: meta, Message: message } = env.data;
  const mmsi = meta.MMSI;
  const ts = parseAisTime(meta.time_utc);
  if (ts === undefined) return;
  const isNew = !state.positions.has(mmsi) && !state.statics.has(mmsi);
  if (isNew && state.positions.size + state.statics.size >= MAX_VESSELS) return;

  if (type.endsWith('PositionReport')) {
    const body = PositionBody.safeParse(message[type]);
    if (!body.success) return;
    const p = body.data;
    state.positions.set(mmsi, {
      lon: meta.longitude,
      lat: meta.latitude,
      ts,
      ...(p.Cog !== undefined && p.Cog < 360 && { cog: p.Cog }),
      ...(p.Sog !== undefined && p.Sog < 102.3 && { sog: p.Sog }),
      ...(p.TrueHeading !== undefined && p.TrueHeading < 360 && { heading: p.TrueHeading }),
      ...(p.NavigationalStatus !== undefined && { navStatus: p.NavigationalStatus }),
      classB: type !== 'PositionReport',
    });
    const name = clean(meta.ShipName);
    if (name && !state.statics.get(mmsi)?.name) {
      state.statics.set(mmsi, { ...state.statics.get(mmsi), ts, name });
    }
  } else if (type === 'ShipStaticData') {
    const body = ShipStatic.safeParse(message[type]);
    if (!body.success) return;
    const s = body.data;
    const name = clean(s.Name);
    const callsign = clean(s.CallSign);
    const destination = clean(s.Destination);
    state.statics.set(mmsi, {
      ts,
      ...(name && { name }),
      ...(callsign && { callsign }),
      ...(s.Type && { type: s.Type }),
      ...(destination && { destination }),
      ...dimensions(s.Dimension),
    });
  } else if (type === 'StaticDataReport') {
    const body = ClassBStatic.safeParse(message[type]);
    if (!body.success) return;
    const prev = state.statics.get(mmsi) ?? { ts };
    const a = body.data.ReportA?.Valid ? body.data.ReportA : undefined;
    const b = body.data.ReportB?.Valid ? body.data.ReportB : undefined;
    const name = clean(a?.Name);
    const callsign = clean(b?.CallSign);
    state.statics.set(mmsi, {
      ...prev,
      ts,
      ...(name && { name }),
      ...(callsign && { callsign }),
      ...(b?.ShipType && { type: b.ShipType }),
      ...dimensions(b?.Dimension),
    });
  }
}

export function pruneAis(state: AisState, now: number): void {
  for (const [mmsi, p] of state.positions) {
    if (now - p.ts > POSITION_MAX_AGE_MS) state.positions.delete(mmsi);
  }
  for (const [mmsi, s] of state.statics) {
    if (now - s.ts > STATIC_MAX_AGE_MS) state.statics.delete(mmsi);
  }
}

/** Broad ship category from the AIS ship-and-cargo type code. */
export function shipCategory(type: number | undefined): string {
  if (type === undefined) return 'unknown';
  if (type === 30) return 'fishing';
  if (type === 31 || type === 32 || type === 52) return 'tug';
  if (type === 35) return 'military';
  if (type === 36) return 'sailing';
  if (type === 37) return 'pleasure';
  if (type >= 40 && type <= 49) return 'high-speed';
  if (type === 50) return 'pilot';
  if (type === 51) return 'search & rescue';
  if (type === 55) return 'law enforcement';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  return 'other';
}

const NAV_STATUS: Record<number, string> = {
  0: 'under way (engine)',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by draught',
  5: 'moored',
  6: 'aground',
  7: 'fishing',
  8: 'under way (sail)',
};

const PRIVATE_CATEGORIES = new Set(['sailing', 'pleasure']);

/**
 * Ship entities. Leisure craft are usually owned by private people, so they are shown
 * without name, call sign or MMSI and with an id that changes when the server restarts.
 */
export function shipEntities(state: AisState, salt: string): Entity[] {
  const entities: Entity[] = [];
  for (const [mmsi, p] of state.positions) {
    const s = state.statics.get(mmsi);
    const category = shipCategory(s?.type);
    const anonymous = PRIVATE_CATEGORIES.has(category) || (p.classB && category === 'unknown');
    const moving = (p.sog ?? 0) >= 0.5;
    const heading = p.heading ?? (moving ? p.cog : undefined);
    const common = {
      source: 'aisstream',
      kind: 'ship' as const,
      lon: p.lon,
      lat: p.lat,
      ...(heading !== undefined && { heading: normalizeHeading(heading) }),
      ...(p.sog !== undefined && { speed: p.sog * KNOTS_TO_MS }),
      ts: new Date(p.ts).toISOString(),
    };
    const shared = {
      category,
      ...(p.sog !== undefined && { speedKn: p.sog }),
      ...(p.navStatus !== undefined &&
        NAV_STATUS[p.navStatus] && { status: NAV_STATUS[p.navStatus] }),
      aisClass: p.classB ? 'B' : 'A',
      ...(s?.lengthM && { lengthM: s.lengthM }),
      ...(s?.beamM && { beamM: s.beamM }),
    };
    if (anonymous) {
      const id = createHash('sha256').update(`${salt}:${mmsi}`).digest('hex').slice(0, 16);
      entities.push({
        ...common,
        id: `anon-${id}`,
        label: category === 'sailing' ? 'Sailing vessel' : 'Small craft',
        props: shared,
      });
      continue;
    }
    entities.push({
      ...common,
      id: String(mmsi),
      label: truncate(s?.name ?? `MMSI ${mmsi}`, 200),
      props: {
        ...shared,
        mmsi,
        ...(s?.callsign && { callsign: s.callsign }),
        ...(s?.destination && { destination: truncate(s.destination, 60) }),
      },
    });
  }
  return entities;
}

const state = createAisState();
const salt = randomBytes(16).toString('hex');
const decoder = new TextDecoder();

export const aisstreamShips: StreamConnector = {
  id: 'aisstream.ships',
  name: 'aisstream.io – ships (AIS)',
  licence: 'aisstream.io terms of use',
  attribution: 'aisstream.io',
  homepage: 'https://aisstream.io/',
  mode: 'stream',
  allowedHosts: ['stream.aisstream.io'],
  requiredEnv: ['AISSTREAM_API_KEY'],
  channels: [{ name: SHIPS, kind: 'entities' }],
  run(ctx) {
    const { west, south, east, north } = GOTHENBURG.bbox;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(STREAM_URL);
      ws.binaryType = 'arraybuffer';
      let lastMessage = Date.now();
      let received = 0;
      let done = false;

      const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastMessage > SILENCE_MS) {
          finish(new UpstreamError('No AIS messages received; reconnecting'));
          return;
        }
        pruneAis(state, now);
        ctx.publish.replace(SHIPS, shipEntities(state, salt));
        if (received > 0) ctx.health.ok();
      }, PUBLISH_MS);

      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        ws.close();
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish();
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            APIKey: ctx.env.AISSTREAM_API_KEY,
            BoundingBoxes: [
              [
                [south, west],
                [north, east],
              ],
            ],
            FilterMessageTypes: MESSAGE_TYPES,
          }),
        );
      };
      ws.onmessage = (event: MessageEvent) => {
        lastMessage = Date.now();
        const data: unknown = event.data;
        const text =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer
              ? decoder.decode(data)
              : undefined;
        if (!text) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          finish(new UpstreamError('aisstream.io rejected the subscription'));
          return;
        }
        received++;
        applyAisMessage(state, parsed);
      };
      ws.onerror = () => finish(new UpstreamError('AIS stream connection error'));
      ws.onclose = (event: CloseEvent) =>
        finish(new UpstreamError(`AIS stream closed (code ${event.code})`));
    });
  },
};
