import type { Frame } from '@gbg-osint/shared';
import {
  Credit,
  ImageryLayer,
  Rectangle,
  SingleTileImageryProvider,
  type CesiumWidget,
} from 'cesium';

const FRAME_MS = 650;
const HOLD_LAST_MS = 2_500;
const FADE_MS = 300;
const OPACITY = 0.8;
const CREDIT = new Credit('Radar © SMHI (CC BY 4.0)', true);

export interface RadarState {
  count: number;
  index: number;
  /** Valid time of the frame on screen. */
  ts: string | null;
  /** Valid time of the newest frame. */
  latest: string | null;
  playing: boolean;
}

interface Slot {
  frame: Frame;
  layer: ImageryLayer;
}

/** Animated precipitation radar: one imagery layer per frame, looping with a short crossfade. */
export class RadarLayer {
  private slots: Slot[] = [];
  private index = 0;
  private previous = -1;
  private playing = true;
  private shownAt = 0;
  private dirty = false;

  constructor(
    private readonly globe: CesiumWidget,
    private readonly onChange: (state: RadarState) => void,
  ) {}

  get state(): RadarState {
    return {
      count: this.slots.length,
      index: this.index,
      ts: this.slots[this.index]?.frame.ts ?? null,
      latest: this.slots.at(-1)?.frame.ts ?? null,
      playing: this.playing,
    };
  }

  set(frames: readonly Frame[]): void {
    const wanted = [...frames].sort((a, b) => a.ts.localeCompare(b.ts));
    const atLatest = this.index >= this.slots.length - 1;
    const byId = new Map(this.slots.map((s) => [s.frame.id, s]));
    const keep = new Set(wanted.map((f) => f.id));
    for (const slot of this.slots) {
      if (!keep.has(slot.frame.id)) this.globe.imageryLayers.remove(slot.layer, true);
    }
    this.slots = wanted.map((frame) => byId.get(frame.id) ?? this.createSlot(frame));
    this.index = atLatest
      ? Math.max(0, this.slots.length - 1)
      : Math.min(this.index, this.slots.length - 1);
    this.previous = -1;
    this.dirty = true;
    this.notify();
  }

  clear(): void {
    for (const slot of this.slots) this.globe.imageryLayers.remove(slot.layer, true);
    this.slots = [];
    this.index = 0;
    this.notify();
  }

  play(playing: boolean): void {
    this.playing = playing;
    this.notify();
  }

  /** Shows a frame (wrapping around) and pauses on it. */
  seek(index: number): void {
    const n = this.slots.length;
    if (n === 0) return;
    this.playing = false;
    this.show(((index % n) + n) % n, performance.now());
    this.previous = -1;
  }

  /** Advances the loop; returns true while the picture changes. */
  update(now: number): boolean {
    const n = this.slots.length;
    if (n === 0) return false;
    const hold = this.index === n - 1 ? HOLD_LAST_MS : FRAME_MS;
    if (this.playing && n > 1 && now - this.shownAt >= hold) this.show((this.index + 1) % n, now);
    const fade = this.previous >= 0 ? Math.min(1, (now - this.shownAt) / FADE_MS) : 1;
    if (!this.dirty && fade >= 1 && this.previous < 0) return false;
    this.slots.forEach((slot, i) => {
      const alpha =
        i === this.index ? OPACITY * fade : i === this.previous ? OPACITY * (1 - fade) : 0;
      slot.layer.show = alpha > 0;
      slot.layer.alpha = alpha;
    });
    if (fade >= 1) this.previous = -1;
    this.dirty = false;
    return true;
  }

  private show(index: number, now: number): void {
    if (index === this.index) return;
    this.previous = this.index;
    this.index = index;
    this.shownAt = now;
    this.dirty = true;
    this.notify();
  }

  private createSlot(frame: Frame): Slot {
    const { west, south, east, north } = frame.bbox;
    const provider = SingleTileImageryProvider.fromUrl(frame.path, {
      rectangle: Rectangle.fromDegrees(west, south, east, north),
      credit: CREDIT,
    });
    const layer = ImageryLayer.fromProviderAsync(provider, { show: false, alpha: 0 });
    this.globe.imageryLayers.add(layer);
    return { frame, layer };
  }

  private notify(): void {
    this.onChange(this.state);
  }
}
