import type { LonLat } from '@gbg-osint/shared';
import { LocalFrame, headingOf, pointAlong, type PathPoint } from './path';

interface Sample extends PathPoint {
  t: number;
}

export interface PlaybackState {
  lon: number;
  lat: number;
  heading: number | undefined;
  /** False once the object has settled, so the caller can stop requesting frames. */
  moving: boolean;
}

export interface SectionPose {
  lon: number;
  lat: number;
  heading: number;
}

/** A position this far from the last one is a different trip or a data glitch: start over. */
const TELEPORT_M = 1_500;
/** More samples than this means playback is far behind the data (e.g. a hidden tab). */
const MAX_SAMPLES = 400;
/** Path kept behind the drawn position: corner rounding and trailing articulated sections. */
const KEEP_BEHIND_M = 30;
/** Seconds over which the playback clock catches up after a data gap. */
const CATCHUP_MS = 20_000;
const MAX_LAG_MS = 90_000;
const MAX_FRAME_MS = 250;
/** Critically damped follower: ~1.3 s smoothing of speed changes. */
const OMEGA = 1.5;
const FILLET_M = 25;
const HEADING_TAU_S = 0.4;
const RAD = Math.PI / 180;

function angleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Plays back irregular position updates as continuous motion. Rendering runs `delayMs` behind
 * the data along the path of received positions (and the route travelled between them, when
 * the data has one), corners rounded; speed changes are smoothed, and when updates stop the
 * object eases to a halt at its last known position instead of jumping.
 */
export class Playback {
  /** Drawn this far right of the path, e.g. a bus in its lane rather than on the centreline. */
  laneOffsetM = 0;
  private frame: LocalFrame | undefined;
  private samples: Sample[] = [];
  private clock: number | undefined;
  private lastFrame: number | undefined;
  private distance = 0;
  private speed = 0;
  private heading: number | undefined;

  constructor(private readonly delayMs: number) {}

  /**
   * Adds a position received at time `t`. `via` is the route travelled since the previous
   * position; its points get times in proportion to distance (steady speed between updates).
   */
  push(t: number, lon: number, lat: number, heading?: number, via?: readonly LonLat[]): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) return;
    const frame = (this.frame ??= new LocalFrame(lon, lat));
    const [x, y] = frame.toXY(lon, lat);
    if (!last || Math.hypot(x - last.x, y - last.y) > TELEPORT_M) {
      this.reset(t, x, y, heading);
      return;
    }
    const points = [...(via ?? []).map(([vLon, vLat]) => frame.toXY(vLon, vLat)), [x, y]];
    const legs: PathPoint[] = [];
    let d = last.d;
    let px = last.x;
    let py = last.y;
    for (const [qx, qy] of points as [number, number][]) {
      const step = Math.hypot(qx - px, qy - py);
      if (step > TELEPORT_M) {
        this.reset(t, x, y, heading);
        return;
      }
      d += step;
      legs.push({ x: qx, y: qy, d });
      px = qx;
      py = qy;
    }
    const total = d - last.d;
    const final = legs.pop()!;
    for (const leg of legs) {
      const prev = this.samples[this.samples.length - 1]!;
      const legT = last.t + ((t - last.t) * (leg.d - last.d)) / total;
      if (leg.d - prev.d < 0.05 || legT <= prev.t || legT >= t) continue;
      this.samples.push({ t: legT, ...leg });
    }
    const n = this.samples.length;
    const tail = this.samples[n - 1]!;
    if (n >= 2 && final.d === tail.d && tail.d === this.samples[n - 2]!.d) {
      // Still standing: extend the wait instead of piling up samples.
      tail.t = t;
    } else {
      this.samples.push({ t, ...final });
    }
    this.trim();
  }

  advance(now: number): PlaybackState | undefined {
    const frame = this.frame;
    const last = this.samples[this.samples.length - 1];
    if (!frame || !last) return undefined;
    const dtMs = Math.min(MAX_FRAME_MS, Math.max(0, now - (this.lastFrame ?? now)));
    this.lastFrame = now;
    const dt = dtMs / 1000;

    const target = now - this.delayMs;
    let clock = this.clock ?? this.samples[0]!.t;
    const rate = Math.min(2, Math.max(0, 1 + (target - clock) / CATCHUP_MS));
    clock = Math.min(last.t, clock + dtMs * rate);
    if (target - clock > MAX_LAG_MS) clock = Math.min(last.t, target - MAX_LAG_MS);
    this.clock = clock;

    const goal = this.distanceAt(clock);
    const accel = OMEGA * OMEGA * (goal - this.distance) - 2 * OMEGA * this.speed;
    this.speed = Math.max(0, this.speed + accel * dt);
    this.distance = Math.min(last.d, this.distance + this.speed * dt);
    if (this.distance >= last.d) this.speed = 0;

    const pos = pointAlong(this.samples, this.distance, FILLET_M);
    if (pos.heading !== undefined && this.speed > 0.05) {
      if (this.heading === undefined) this.heading = pos.heading;
      else {
        const k = 1 - Math.exp(-dt / HEADING_TAU_S);
        this.heading = (this.heading + angleDelta(this.heading, pos.heading) * k + 360) % 360;
      }
    }
    const [lon, lat] = frame.toLonLat(...this.offsetXY(pos.x, pos.y));
    const settling = Math.abs(goal - this.distance) > 0.05 || this.speed > 0.01;
    return { lon, lat, heading: this.heading, moving: settling || clock < last.t };
  }

  /**
   * Pose of a rigid body section whose centre is `offsetM` along the path from the drawn
   * position (+ ahead) and whose two pivots sit on the path `halfM` either side of it.
   * Beyond the known path the last (or first) direction is extended.
   */
  sectionPose(offsetM: number, halfM: number): SectionPose | undefined {
    const frame = this.frame;
    if (!frame || this.samples.length === 0) return undefined;
    const centre = this.distance + offsetM;
    const [ax, ay] = this.pathPoint(centre - halfM);
    const [bx, by] = this.pathPoint(centre + halfM);
    const heading = headingOf(bx - ax, by - ay) ?? this.heading ?? 0;
    const [lon, lat] = frame.toLonLat(...this.offsetXY((ax + bx) / 2, (ay + by) / 2));
    return { lon, lat, heading };
  }

  /** Latest known position (what the data says now, not what is drawn). */
  latest(): LonLat | undefined {
    const last = this.samples[this.samples.length - 1];
    return last && this.frame ? this.frame.toLonLat(last.x, last.y) : undefined;
  }

  private offsetXY(x: number, y: number): [number, number] {
    if (this.laneOffsetM === 0 || this.heading === undefined) return [x, y];
    const r = this.heading * RAD;
    return [x + Math.cos(r) * this.laneOffsetM, y - Math.sin(r) * this.laneOffsetM];
  }

  /** Point at path distance `d`, continuing straight beyond either end of the known path. */
  private pathPoint(d: number): [number, number] {
    const s = this.samples;
    const first = s[0]!;
    const last = s[s.length - 1]!;
    if (d >= first.d && d <= last.d) {
      const p = pointAlong(s, d, FILLET_M);
      return [p.x, p.y];
    }
    const atStart = d < first.d;
    const end = atStart ? first : last;
    const [ux, uy] = this.endDirection(atStart);
    const over = d - end.d;
    return [end.x + ux * over, end.y + uy * over];
  }

  /** Unit direction of travel at the start or end of the known path. */
  private endDirection(atStart: boolean): [number, number] {
    const s = this.samples;
    const end = atStart ? s[0]! : s[s.length - 1]!;
    for (let k = 1; k < s.length; k++) {
      const other = atStart ? s[k]! : s[s.length - 1 - k]!;
      const len = Math.abs(other.d - end.d);
      if (len < 0.5) continue;
      const sign = atStart ? 1 : -1;
      return [(sign * (other.x - end.x)) / len, (sign * (other.y - end.y)) / len];
    }
    const h = (this.heading ?? 0) * RAD;
    return [Math.sin(h), Math.cos(h)];
  }

  private reset(t: number, x: number, y: number, heading: number | undefined): void {
    this.samples = [{ t, x, y, d: 0 }];
    this.clock = t;
    this.distance = 0;
    this.speed = 0;
    this.heading = heading ?? this.heading;
  }

  private distanceAt(t: number): number {
    const s = this.samples;
    if (t <= s[0]!.t) return s[0]!.d;
    for (let i = 1; i < s.length; i++) {
      const b = s[i]!;
      if (t <= b.t) {
        const a = s[i - 1]!;
        return a.d + ((b.d - a.d) * (t - a.t)) / (b.t - a.t);
      }
    }
    return s[s.length - 1]!.d;
  }

  /** Drops samples the playback has passed, keeping KEEP_BEHIND_M of path behind it. */
  private trim(): void {
    let keepFrom = 0;
    const clock = this.clock ?? 0;
    while (
      keepFrom < this.samples.length - 2 &&
      this.samples[keepFrom + 1]!.t <= clock &&
      this.samples[keepFrom + 1]!.d <= this.distance - KEEP_BEHIND_M
    ) {
      keepFrom++;
    }
    if (keepFrom > 0) this.samples = this.samples.slice(keepFrom);
    if (this.samples.length > MAX_SAMPLES) {
      // Far behind the data (e.g. the tab was hidden): continue from the newest positions.
      const last = this.samples[this.samples.length - 1]!;
      this.reset(last.t, last.x, last.y, this.heading);
    }
  }
}
