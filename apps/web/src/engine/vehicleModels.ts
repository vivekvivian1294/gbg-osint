import { ACCENT, MeshBuilder, type Paint } from './gltf';

export type ModelKind =
  | 'tram'
  | 'tram-cab'
  | 'tram-mid'
  | 'bus'
  | 'ferry'
  | 'train'
  | 'train-car'
  | 'car'
  | 'cargo'
  | 'tanker'
  | 'passenger'
  | 'highspeed'
  | 'tug'
  | 'smallcraft'
  | 'fishing'
  | 'sailing'
  | 'motorboat'
  | 'naval'
  | 'vessel'
  | 'camera';

export interface ModelDef {
  /** Nominal hull or body size the mesh is built at; ships are scaled to their AIS size. */
  length: number;
  beam: number;
  build(): MeshBuilder;
}

const VT_BLUE = '#1b5fae';
const WHITE = '#eef2f5';
const GLASS = '#1c2733';
const DARK = '#23282d';
const ROOF = '#a9b3bb';
const STEEL = '#59636b';

type Pt = readonly [number, number];

/** Footprint with chamfered front (and optionally rear) corners, counter-clockwise. */
function chamfered(x0: number, x1: number, halfW: number, front: number, rear = 0): Pt[] {
  return [
    [x0, -halfW + rear],
    [x0 + rear, -halfW],
    [x1 - front, -halfW],
    [x1, -halfW + front],
    [x1, halfW - front],
    [x1 - front, halfW],
    [x0 + rear, halfW],
    [x0, halfW - rear],
  ];
}

/** Ship hull: tapered stern, parallel midbody, pointed bow (counter-clockwise). */
function hullFootprint(length: number, beam: number, bow = 0.22, stern = 0.9): Pt[] {
  const half = beam / 2;
  const x0 = -length / 2;
  const x1 = length / 2;
  const bowStart = x1 - length * bow;
  return [
    [x0, -half * stern],
    [x0 + length * 0.08, -half],
    [bowStart, -half],
    [x1 - length * bow * 0.35, -half * 0.55],
    [x1, 0],
    [x1 - length * bow * 0.35, half * 0.55],
    [bowStart, half],
    [x0 + length * 0.08, half],
    [x0, half * stern],
  ];
}

function hull(
  m: MeshBuilder,
  length: number,
  beam: number,
  height: number,
  side: Paint,
  boot: Paint,
  deck: Paint,
  bow?: number,
) {
  const fp = hullFootprint(length, beam, bow);
  m.prism(fp, -0.4, height * 0.35, boot);
  m.prism(fp, height * 0.35, height, side, deck);
}

/** Dark window strip on both sides of a body section. */
function sideWindows(
  m: MeshBuilder,
  x0: number,
  x1: number,
  halfW: number,
  z0: number,
  z1: number,
  paint = GLASS,
) {
  m.box([x0, halfW, z0], [x1, halfW + 0.04, z1], paint);
  m.box([x0, -halfW - 0.04, z0], [x1, -halfW, z1], paint);
}

const TRAM_HALF_W = 1.32;

/** One tram body section; a cab end gets a windscreen and line sign. */
function tramSection(m: MeshBuilder, x0: number, x1: number, frontCab: boolean, rearCab: boolean) {
  const halfW = TRAM_HALF_W;
  const front = frontCab ? 0.45 : 0;
  const rear = rearCab ? 0.45 : 0;
  m.prism(chamfered(x0, x1, halfW, front * 0.5, rear * 0.5), 0.35, 1.05, VT_BLUE);
  m.prism(chamfered(x0, x1, halfW, front, rear), 1.05, 3.1, WHITE, ROOF);
  m.box([x0 + 0.3, -halfW - 0.03, 1.05], [x1 - 0.3, halfW + 0.03, 1.2], ACCENT);
  sideWindows(m, x0 + 0.6, x1 - 0.6, halfW, 1.35, 2.5);
  m.box([x0 + 1.2, -0.85, 3.1], [x1 - 1.2, 0.85, 3.35], ROOF);
  m.box([x0 + 0.8, -1.1, 0.05], [x0 + 2.6, 1.1, 0.35], DARK);
  m.box([x1 - 2.6, -1.1, 0.05], [x1 - 0.8, 1.1, 0.35], DARK);
  if (frontCab) {
    m.box([x1 - 0.07, -0.8, 1.4], [x1 + 0.05, 0.8, 2.6], GLASS);
    m.box([x1 - 0.1, -0.6, 2.7], [x1 + 0.05, 0.6, 3.0], ACCENT);
  }
  if (rearCab) {
    m.box([x0 - 0.05, -0.8, 1.4], [x0 + 0.07, 0.8, 2.6], GLASS);
    m.box([x0 - 0.05, -0.6, 2.7], [x0 + 0.1, 0.6, 3.0], ACCENT);
  }
}

function pantograph(m: MeshBuilder, x: number, roof: number) {
  m.box([x - 1.2, -0.05, roof], [x + 1.2, 0.05, roof + 0.55], DARK);
  m.box([x - 0.2, -0.8, roof + 0.5], [x + 0.2, 0.8, roof + 0.6], DARK);
}

function tram(): MeshBuilder {
  const m = new MeshBuilder();
  tramSection(m, -14.9, -5.4, false, true);
  tramSection(m, -5.0, 5.0, false, false);
  tramSection(m, 5.4, 14.9, true, false);
  m.box([-5.4, -1.15, 0.5], [-5.0, 1.15, 3.0], DARK);
  m.box([5.0, -1.15, 0.5], [5.4, 1.15, 3.0], DARK);
  pantograph(m, 0, 3.35);
  return m;
}

/** End section of the articulated tram, cab towards +x. */
function tramCab(): MeshBuilder {
  const m = new MeshBuilder();
  tramSection(m, -4.75, 4.75, true, false);
  return m;
}

/** Middle section with the bellows to both end sections and the pantograph. */
function tramMid(): MeshBuilder {
  const m = new MeshBuilder();
  tramSection(m, -5.0, 5.0, false, false);
  m.box([-5.4, -1.15, 0.5], [-5.0, 1.15, 3.0], DARK);
  m.box([5.0, -1.15, 0.5], [5.4, 1.15, 3.0], DARK);
  pantograph(m, 0, 3.35);
  return m;
}

function bus(): MeshBuilder {
  const m = new MeshBuilder();
  const halfW = 1.27;
  m.prism(chamfered(-6, 6, halfW, 0.3, 0.2), 0.35, 1.2, VT_BLUE);
  m.prism(chamfered(-6, 6, halfW, 0.3, 0.2), 1.2, 3.0, WHITE, WHITE);
  m.box([-5.8, -halfW - 0.03, 1.2], [5.7, halfW + 0.03, 1.32], ACCENT);
  sideWindows(m, -5.4, 5.2, halfW, 1.45, 2.55);
  m.box([5.97, -1.1, 1.0], [6.04, 1.1, 2.6], GLASS);
  m.box([5.95, -0.9, 2.62], [6.05, 0.9, 2.9], ACCENT);
  m.box([-6.04, -0.8, 2.3], [-5.97, 0.8, 2.75], ACCENT);
  m.box([-3.5, -1.0, 3.0], [1.5, 1.0, 3.3], ROOF);
  for (const x of [-3.8, 3.6]) {
    m.box([x - 0.5, -halfW - 0.05, 0], [x + 0.5, -halfW + 0.3, 0.9], DARK);
    m.box([x - 0.5, halfW - 0.3, 0], [x + 0.5, halfW + 0.05, 0.9], DARK);
  }
  return m;
}

const TRAIN_HALF_W = 1.6;

function trainCarBody(m: MeshBuilder, x0: number, x1: number, frontCab: boolean, rearCab: boolean) {
  const halfW = TRAIN_HALF_W;
  const front = frontCab ? 2.2 : 0;
  const rear = rearCab ? 2.2 : 0;
  m.prism(chamfered(x0, x1, halfW, front * 0.4, rear * 0.4), 0.6, 1.4, VT_BLUE);
  m.prism(chamfered(x0, x1, halfW, front, rear), 1.4, 3.9, WHITE, ROOF);
  m.box([x0 + 0.5, -halfW - 0.03, 1.4], [x1 - 0.5, halfW + 0.03, 1.55], ACCENT);
  sideWindows(m, x0 + 1.5, x1 - 1.5, halfW, 1.9, 2.9);
  m.box([x0 + 2, -1.3, 0.1], [x0 + 4.5, 1.3, 0.6], DARK);
  m.box([x1 - 4.5, -1.3, 0.1], [x1 - 2, 1.3, 0.6], DARK);
}

function train(): MeshBuilder {
  const m = new MeshBuilder();
  trainCarBody(m, -26, -0.4, false, true);
  trainCarBody(m, 0.4, 26, true, false);
  m.box([-0.4, -1.3, 0.8], [0.4, 1.3, 3.6], DARK);
  m.box([-1.5, -0.05, 3.9], [1.5, 0.05, 4.6], DARK);
  return m;
}

/** One car of the articulated train, cab towards +x, half the gangway at the inner end. */
function trainCar(): MeshBuilder {
  const m = new MeshBuilder();
  trainCarBody(m, -12.8, 12.8, true, false);
  m.box([-13.2, -1.3, 0.8], [-12.8, 1.3, 3.6], DARK);
  m.box([-10.5, -0.05, 3.9], [-7.5, 0.05, 4.6], DARK);
  return m;
}

function car(): MeshBuilder {
  const m = new MeshBuilder();
  m.prism(chamfered(-2.25, 2.25, 0.9, 0.35, 0.25), 0.28, 0.85, ACCENT);
  m.prism(chamfered(-1.45, 0.95, 0.78, 0.45, 0.2), 0.85, 1.42, ACCENT);
  sideWindows(m, -1.25, 0.6, 0.78, 0.92, 1.32);
  m.box([0.86, -0.7, 0.92], [0.95, 0.7, 1.3], GLASS);
  m.box([-1.47, -0.68, 0.95], [-1.4, 0.68, 1.3], GLASS);
  for (const x of [-1.4, 1.35]) {
    m.box([x - 0.33, 0.72, 0], [x + 0.33, 0.95, 0.62], DARK);
    m.box([x - 0.33, -0.95, 0], [x + 0.33, -0.72, 0.62], DARK);
  }
  m.box([2.2, -0.75, 0.6], [2.27, -0.45, 0.75], '#f8f4e0');
  m.box([2.2, 0.45, 0.6], [2.27, 0.75, 0.75], '#f8f4e0');
  m.box([-2.27, -0.8, 0.6], [-2.2, -0.5, 0.75], '#c81e1e');
  m.box([-2.27, 0.5, 0.6], [-2.2, 0.8, 0.75], '#c81e1e');
  return m;
}

/** Road camera on a mast; the housing looks along +x. */
function camera(): MeshBuilder {
  const m = new MeshBuilder();
  m.box([-0.12, -0.12, 0], [0.12, 0.12, 7], STEEL);
  m.box([-0.1, -0.1, 6.6], [0.5, 0.1, 6.8], STEEL);
  m.box([0.2, -0.22, 6.8], [1.1, 0.22, 7.25], '#d9dee3');
  m.box([1.1, -0.18, 6.85], [1.16, 0.18, 7.2], GLASS);
  m.box([0.15, -0.26, 7.25], [1.2, 0.26, 7.32], ACCENT);
  return m;
}

function ferry(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 30, 8, 1.8, WHITE, VT_BLUE, '#7d878f', 0.18);
  m.box([-9, -3.1, 1.8], [7, 3.1, 4.2], WHITE);
  m.box([-9.05, -3.15, 1.8], [7.05, 3.15, 2.0], ACCENT);
  sideWindows(m, -8.5, 6.5, 3.1, 2.4, 3.6);
  m.box([0, -1.8, 4.2], [5, 1.8, 6.2], WHITE);
  sideWindows(m, 0.3, 4.7, 1.8, 4.9, 5.8);
  m.box([4.98, -1.6, 4.8], [5.05, 1.6, 5.9], GLASS);
  m.box([-3, -0.05, 4.2], [-2.8, 0.05, 8], DARK);
  return m;
}

function containerStacks(m: MeshBuilder, x0: number, x1: number, halfW: number, z: number) {
  const colors = ['#b7412e', '#2f6f9f', '#d1a43b', '#3d7a4a', '#8a8f96', '#6b3f8a', '#c25d1c'];
  let i = 0;
  for (let x = x0; x + 12 <= x1; x += 13) {
    for (const [y0, y1] of [
      [-halfW, 0],
      [0, halfW],
    ] as const) {
      const tiers = 3 + ((i * 7) % 3);
      m.box([x, y0 + 0.2, z], [x + 12, y1 - 0.2, z + tiers * 2.6], colors[i % colors.length]!);
      i++;
    }
  }
}

function superstructure(
  m: MeshBuilder,
  x0: number,
  x1: number,
  halfW: number,
  z0: number,
  z1: number,
) {
  m.box([x0, -halfW, z0], [x1, halfW, z1], WHITE);
  for (let z = z0 + 2.2; z < z1 - 1; z += 2.8)
    sideWindows(m, x0 + 0.5, x1 - 0.5, halfW, z, z + 0.9);
  m.box([x1 - 0.02, -halfW + 0.5, z1 - 2.2], [x1 + 0.04, halfW - 0.5, z1 - 1.0], GLASS);
  m.box([x1 - 3, -halfW - 2, z1 - 0.6], [x1, halfW + 2, z1], WHITE);
}

function funnel(m: MeshBuilder, x: number, z: number, height: number, width: number) {
  m.box([x - width, -width * 0.8, z], [x + width, width * 0.8, z + height], ACCENT);
  m.box([x - width, -width * 0.8, z + height], [x + width, width * 0.8, z + height + 0.8], DARK);
}

function cargo(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 120, 20, 9, '#26303b', '#8e2b2b', '#4d555c');
  containerStacks(m, -42, 44, 9, 9);
  superstructure(m, -56, -45, 8, 9, 23);
  funnel(m, -52, 23, 4, 2);
  return m;
}

function tanker(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 120, 20, 8, '#7a2424', '#262626', '#53674f');
  m.box([-42, -0.8, 8], [48, 0.8, 9.2], '#9aa3a8');
  for (let x = -35; x < 45; x += 15) m.box([x, -6, 8], [x + 2, 6, 8.8], '#c9b037');
  m.box([2, -9, 8], [6, 9, 9.5], '#9aa3a8');
  superstructure(m, -56, -45, 8, 8, 21);
  funnel(m, -52, 21, 4, 2);
  return m;
}

function passenger(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 160, 28, 10, WHITE, '#1f3a68', '#8b949b', 0.18);
  const decks: [number, number, number][] = [
    [-70, 52, 13],
    [-66, 46, 12.6],
    [-60, 40, 11.8],
    [-48, 34, 10.6],
  ];
  decks.forEach(([x0, x1, halfW], i) => {
    const z0 = 10 + i * 3;
    m.box([x0, -halfW, z0], [x1, halfW, z0 + 3], WHITE);
    sideWindows(m, x0 + 1, x1 - 1, halfW, z0 + 1, z0 + 2.1);
  });
  m.box([33.95, -8, 20], [34.05, 8, 21.8], GLASS);
  funnel(m, -38, 22, 6, 4);
  return m;
}

function highspeed(): MeshBuilder {
  const m = new MeshBuilder();
  for (const y of [-3.6, 3.6]) {
    m.prism(
      hullFootprint(40, 2.8, 0.3).map(([x, yy]): Pt => [x, yy + y]),
      -0.5,
      2.2,
      WHITE,
    );
  }
  m.box([-18, -5, 2.2], [14, 5, 5], WHITE);
  m.box([-18.05, -5.05, 2.2], [14.05, 5.05, 2.5], ACCENT);
  sideWindows(m, -16, 12, 5, 3, 4.3);
  m.box([2, -3, 5], [10, 3, 7], WHITE);
  m.box([9.98, -2.6, 5.6], [10.05, 2.6, 6.6], GLASS);
  return m;
}

function tug(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 28, 10, 3.2, '#b3261e', '#1f1f1f', '#4a5157', 0.28);
  m.box([-4, -3.2, 3.2], [5, 3.2, 6], WHITE);
  m.box([0, -2.6, 6], [5, 2.6, 8.4], WHITE);
  sideWindows(m, 0.3, 4.7, 2.6, 6.8, 7.9);
  m.box([4.98, -2.3, 6.8], [5.05, 2.3, 7.9], GLASS);
  funnel(m, -2.2, 6, 2, 0.8);
  m.box([2, -0.08, 8.4], [2.2, 0.08, 11], DARK);
  return m;
}

function smallcraft(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 16, 5, 1.8, '#22313f', '#111820', '#56606a', 0.3);
  m.box([-3, -1.9, 1.8], [3, 1.9, 4], ACCENT);
  sideWindows(m, -2.5, 2.6, 1.9, 2.8, 3.6);
  m.box([2.98, -1.6, 2.8], [3.05, 1.6, 3.7], GLASS);
  m.box([-0.5, -0.06, 4], [-0.3, 0.06, 6], DARK);
  return m;
}

function fishing(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 20, 6.5, 2.4, '#1e4f8a', '#7a2020', '#5f6a72', 0.25);
  m.box([1, -2.3, 2.4], [6, 2.3, 5.2], WHITE);
  sideWindows(m, 1.4, 5.6, 2.3, 4, 4.8);
  m.box([5.98, -2, 4], [6.05, 2, 4.9], GLASS);
  m.box([-1, -0.08, 2.4], [-0.8, 0.08, 8.5], DARK);
  m.box([-7.5, -2.8, 2.4], [-7.2, 2.8, 6], ACCENT);
  return m;
}

function sailing(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 11, 3.6, 1.2, WHITE, '#1f3a68', '#c8b48a', 0.3);
  m.box([-2.5, -1.1, 1.2], [1.5, 1.1, 1.9], WHITE);
  sideWindows(m, -2, 1, 1.1, 1.4, 1.7);
  m.box([0.9, -0.08, 1.2], [1.1, 0.08, 15], ROOF);
  m.face(
    [
      [1.2, 0, 2],
      [1.2, 0, 14.5],
      [4.9, 0, 2],
    ],
    '#f4f4f0',
  );
  m.face(
    [
      [0.8, 0, 2.2],
      [0.8, 0, 13],
      [-3.8, 0, 2.2],
    ],
    '#f4f4f0',
  );
  return m;
}

function motorboat(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 9, 3, 1.1, WHITE, '#2b3a4a', '#d9d2c0', 0.35);
  m.box([-1.6, -1.1, 1.1], [1.2, 1.1, 1.9], WHITE);
  m.box([1.18, -1.0, 1.25], [1.25, 1.0, 1.8], GLASS);
  m.box([-4.2, -0.05, 1.1], [-3.8, 0.05, 1.6], ACCENT);
  return m;
}

function naval(): MeshBuilder {
  const m = new MeshBuilder();
  const grey = '#8a949c';
  hull(m, 60, 9, 4, grey, '#3c4349', '#6e777e', 0.25);
  m.box([-14, -3.5, 4], [10, 3.5, 8], grey);
  m.box([2, -2.6, 8], [9, 2.6, 10.5], grey);
  m.box([8.98, -2.2, 9], [9.05, 2.2, 10], GLASS);
  m.box([0, -0.4, 10.5], [1, 0.4, 16], grey);
  m.box([18, -1.2, 4], [22, 1.2, 5.5], grey);
  return m;
}

function vessel(): MeshBuilder {
  const m = new MeshBuilder();
  hull(m, 40, 9, 3.5, '#3d454c', '#7a2a2a', '#5a636b');
  superstructure(m, -17, -6, 3.8, 3.5, 10);
  funnel(m, -14, 10, 2, 1);
  m.box([4, -3.5, 3.5], [16, 3.5, 5], STEEL);
  return m;
}

export const MODELS: Record<ModelKind, ModelDef> = {
  tram: { length: 29.8, beam: 2.65, build: tram },
  'tram-cab': { length: 9.5, beam: 2.65, build: tramCab },
  'tram-mid': { length: 10.8, beam: 2.65, build: tramMid },
  bus: { length: 12, beam: 2.55, build: bus },
  train: { length: 52, beam: 3.2, build: train },
  'train-car': { length: 26.4, beam: 3.2, build: trainCar },
  ferry: { length: 30, beam: 8, build: ferry },
  car: { length: 4.5, beam: 1.8, build: car },
  cargo: { length: 120, beam: 20, build: cargo },
  tanker: { length: 120, beam: 20, build: tanker },
  passenger: { length: 160, beam: 28, build: passenger },
  highspeed: { length: 40, beam: 10, build: highspeed },
  tug: { length: 28, beam: 10, build: tug },
  smallcraft: { length: 16, beam: 5, build: smallcraft },
  fishing: { length: 20, beam: 6.5, build: fishing },
  sailing: { length: 11, beam: 3.6, build: sailing },
  motorboat: { length: 9, beam: 3, build: motorboat },
  naval: { length: 60, beam: 9, build: naval },
  vessel: { length: 40, beam: 9, build: vessel },
  camera: { length: 1.4, beam: 0.6, build: camera },
};

/** A rigid body section of an articulated vehicle, placed along the path it follows. */
export interface ModelSection {
  kind: ModelKind;
  /** Centre of the section along the vehicle from its middle, metres (+ forward). */
  offset: number;
  /** Half the distance between the section's two pivots on the path. */
  half: number;
  /** Drawn facing backwards (a cab section at the rear). */
  flip?: boolean;
}

/** Vehicles drawn as sections that each follow the path, so they bend through curves. */
export const ARTICULATION: Partial<Record<ModelKind, readonly ModelSection[]>> = {
  tram: [
    { kind: 'tram-cab', offset: 10.15, half: 4.75 },
    { kind: 'tram-mid', offset: 0, half: 5 },
    { kind: 'tram-cab', offset: -10.15, half: 4.75, flip: true },
  ],
  train: [
    { kind: 'train-car', offset: 13.2, half: 12.8 },
    { kind: 'train-car', offset: -13.2, half: 12.8, flip: true },
  ],
};

const SHIP_MODELS: Record<string, ModelKind> = {
  cargo: 'cargo',
  tanker: 'tanker',
  passenger: 'passenger',
  'high-speed': 'highspeed',
  tug: 'tug',
  pilot: 'smallcraft',
  'search & rescue': 'smallcraft',
  'law enforcement': 'smallcraft',
  fishing: 'fishing',
  sailing: 'sailing',
  pleasure: 'motorboat',
  military: 'naval',
};

/** Hull model for an AIS ship category; unknown small vessels get a motorboat. */
export function shipModel(category: string, lengthM?: number): ModelKind {
  const kind = SHIP_MODELS[category];
  if (kind) return kind;
  return lengthM !== undefined && lengthM < 15 ? 'motorboat' : 'vessel';
}

/** Per-axis scale that fits a nominal model to the reported length and beam. */
export function shipScale(
  kind: ModelKind,
  lengthM?: number,
  beamM?: number,
): [number, number, number] {
  const def = MODELS[kind];
  const sx = lengthM !== undefined && lengthM > 0 ? lengthM / def.length : 1;
  const sy = beamM !== undefined && beamM > 0 ? beamM / def.beam : sx;
  const sz = Math.min(2.2, Math.max(0.4, Math.sqrt(sx * sy)));
  return [sx, sy, sz];
}
