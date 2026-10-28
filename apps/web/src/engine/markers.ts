import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  VerticalOrigin,
  type Billboard,
  type Label,
  type Scene,
} from 'cesium';
import { getIcon } from './icons';
import { isPickRef, type MarkerSpec, type PickRef } from './markerSpec';
import { ModelLayer, type ModelInstance } from './modelLayer';
import { Playback } from './playback';
import { ARTICULATION } from './vehicleModels';

interface Position {
  lon: number;
  lat: number;
  alt: number;
}

interface Track {
  spec: MarkerSpec;
  billboard: Billboard;
  label: Label | undefined;
  from: Position;
  to: Position;
  t0: number;
  duration: number;
  stale: boolean;
  playback: Playback | undefined;
  /** Heading currently drawn (smoothed for played-back tracks). */
  heading: number | undefined;
}

const STALE_ALPHA = 0.35;
const SCALE_BY_DISTANCE = new NearFarScalar(2_000, 1.0, 3_000_000, 0.45);
// Within this camera distance markers draw on top of the globe instead of z-fighting with it.
const NO_DEPTH_TEST_DISTANCE = 2_000_000;
const LABEL_OFFSET = new Cartesian2(0, -18);
const MAX_MODELS = 160;
const HEADING_EPSILON = 0.5;

function lerp(a: Position, b: Position, f: number): Position {
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return {
    lon: a.lon + dLon * f,
    lat: a.lat + (b.lat - a.lat) * f,
    alt: a.alt + (b.alt - a.alt) * f,
  };
}

function isStale(spec: MarkerSpec, now: number): boolean {
  return (
    spec.ts !== undefined && spec.staleAfterMs !== undefined && now - spec.ts > spec.staleAfterMs
  );
}

/**
 * Draws markers with Cesium primitive collections. Moving markers glide between updates
 * (rendered roughly one update interval behind) and fade when their data goes stale. Markers
 * with a model spec are drawn as low-poly 3D models when the camera is close.
 */
export class MarkerRenderer {
  private readonly billboards: BillboardCollection;
  private readonly labels: LabelCollection;
  private readonly models: ModelLayer;
  private readonly tracks = new Map<string, Track>();
  private readonly scratch = new Cartesian3();

  constructor(private readonly scene: Scene) {
    this.billboards = scene.primitives.add(new BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new LabelCollection({ scene }));
    this.models = new ModelLayer(scene, { minimumPixelSize: 20, maximumScale: 6 });
  }

  sync(specs: readonly MarkerSpec[], now = performance.now(), wallNow = Date.now()): void {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.key);
      const track = this.tracks.get(spec.key);
      if (track) this.update(track, spec, now, wallNow);
      else this.create(spec, now, wallNow);
    }
    for (const [key, track] of this.tracks) {
      if (seen.has(key)) continue;
      this.billboards.remove(track.billboard);
      if (track.label) this.labels.remove(track.label);
      this.tracks.delete(key);
    }
    this.scene.requestRender();
  }

  /** Advances motion, staleness and 3D models; returns true if anything changed on screen. */
  tick(now = performance.now(), wallNow = Date.now()): boolean {
    let changed = false;
    for (const t of this.tracks.values()) {
      if (t.playback) {
        const state = t.playback.advance(now);
        if (state) {
          this.place(t, { lon: state.lon, lat: state.lat, alt: t.spec.alt });
          if (
            state.heading !== undefined &&
            (t.heading === undefined || Math.abs(state.heading - t.heading) > HEADING_EPSILON)
          ) {
            t.heading = state.heading;
            this.applyHeading(t);
          }
          if (state.moving) changed = true;
        }
      } else if (t.duration > 0) {
        const f = Math.min(1, (now - t.t0) / t.duration);
        this.place(t, lerp(t.from, t.to, f));
        if (f >= 1) t.duration = 0;
        changed = true;
      }
      const stale = isStale(t.spec, wallNow);
      if (stale !== t.stale) {
        t.stale = stale;
        this.applyColor(t);
        changed = true;
      }
    }
    return this.updateModels() || changed;
  }

  pick(position: Cartesian2): PickRef | undefined {
    return this.resolvePick(this.scene.pick(position));
  }

  /** PickRef behind a `scene.pick` result from one of this renderer's markers or models. */
  resolvePick(picked: unknown): PickRef | undefined {
    const fromModel = this.models.pickOf(picked);
    if (isPickRef(fromModel)) return fromModel;
    const id = picked && typeof picked === 'object' && 'id' in picked ? picked.id : undefined;
    return isPickRef(id) ? id : undefined;
  }

  /** Current (interpolated) on-screen state of every marker. */
  *entries(): Generator<{ key: string; spec: MarkerSpec; position: Cartesian3; stale: boolean }> {
    for (const [key, t] of this.tracks) {
      yield { key, spec: t.spec, position: t.billboard.position, stale: t.stale };
    }
  }

  positionOf(key: string): Cartesian3 | undefined {
    return this.tracks.get(key)?.billboard.position;
  }

  /** Heading currently drawn (smoothed for played-back markers). */
  headingOf(key: string): number | undefined {
    return this.tracks.get(key)?.heading;
  }

  specOf(key: string): MarkerSpec | undefined {
    return this.tracks.get(key)?.spec;
  }

  findKey(layerId: string, id: string): string | undefined {
    for (const [key, t] of this.tracks) {
      const { pick } = t.spec;
      if (pick.layerId === layerId && pick.ids.length === 1 && pick.ids[0] === id) return key;
    }
    return undefined;
  }

  destroy(): void {
    if (this.scene.isDestroyed()) return;
    this.models.destroy();
    this.scene.primitives.remove(this.billboards);
    this.scene.primitives.remove(this.labels);
  }

  /** Swaps icons for 3D models on the nearest modelled markers; true if the swap changed. */
  private updateModels(): boolean {
    const camera = this.scene.camera.positionWC;
    const near: { track: Track; key: string; dist: number }[] = [];
    for (const [key, track] of this.tracks) {
      const model = track.spec.model;
      if (!model) continue;
      const dist = Cartesian3.distance(camera, track.billboard.position);
      if (dist <= model.range) near.push({ track, key, dist });
    }
    near.sort((a, b) => a.dist - b.dist);
    const instances: ModelInstance[] = [];
    const owners = new Map<string, string>();
    for (const { track, key } of near.slice(0, MAX_MODELS)) {
      const model = track.spec.model!;
      const common = {
        accent: model.accent,
        alpha: track.stale ? STALE_ALPHA : 1,
        pick: track.spec.pick,
      };
      const sections = track.playback && ARTICULATION[model.kind];
      if (sections) {
        // Each section follows the path on its own, so the vehicle bends through curves.
        sections.forEach((section, i) => {
          const pose = track.playback!.sectionPose(section.offset, section.half);
          if (!pose) return;
          const sectionKey = `${key}#${i}`;
          owners.set(sectionKey, key);
          instances.push({
            key: sectionKey,
            kind: section.kind,
            position: Cartesian3.fromDegrees(pose.lon, pose.lat, track.spec.alt),
            heading: section.flip ? pose.heading + 180 : pose.heading,
            ...common,
          });
        });
        continue;
      }
      owners.set(key, key);
      instances.push({
        key,
        kind: model.kind,
        position: track.billboard.position,
        heading: track.heading ?? 0,
        ...(model.scale && { scale: model.scale }),
        ...common,
      });
    }
    const shown = new Set<string>();
    for (const instanceKey of this.models.update(instances)) {
      shown.add(owners.get(instanceKey)!);
    }
    let changed = false;
    for (const [key, track] of this.tracks) {
      const show = !shown.has(key);
      if (track.billboard.show !== show) {
        track.billboard.show = show;
        changed = true;
      }
    }
    return changed;
  }

  private create(spec: MarkerSpec, now: number, wallNow: number): void {
    const pos = { lon: spec.lon, lat: spec.lat, alt: spec.alt };
    const cartesian = Cartesian3.fromDegrees(pos.lon, pos.lat, pos.alt);
    const billboard = this.billboards.add({
      position: cartesian,
      scale: spec.scale ?? 1,
      scaleByDistance: SCALE_BY_DISTANCE,
      disableDepthTestDistance: NO_DEPTH_TEST_DISTANCE,
      id: spec.pick,
    });
    billboard.setImage(spec.icon, getIcon(spec.icon));
    let playback: Playback | undefined;
    if (spec.playbackDelayMs) {
      playback = new Playback(spec.playbackDelayMs);
      playback.laneOffsetM = spec.laneOffsetM ?? 0;
      playback.push(now, spec.lon, spec.lat, spec.heading);
    }
    const track: Track = {
      spec,
      billboard,
      label: undefined,
      from: pos,
      to: pos,
      t0: 0,
      duration: 0,
      stale: isStale(spec, wallNow),
      playback,
      heading: spec.heading,
    };
    this.applyHeading(track);
    this.applyColor(track);
    this.applyLabel(track, cartesian);
    this.tracks.set(spec.key, track);
  }

  private update(track: Track, spec: MarkerSpec, now: number, wallNow: number): void {
    const prev = track.spec;
    track.spec = spec;
    const target = { lon: spec.lon, lat: spec.lat, alt: spec.alt };
    const moved =
      target.lon !== track.to.lon || target.lat !== track.to.lat || target.alt !== track.to.alt;
    if (track.playback) {
      if (moved) track.playback.push(now, spec.lon, spec.lat, spec.heading, spec.via);
      else if (spec.ts !== prev.ts) track.playback.push(now, spec.lon, spec.lat, spec.heading);
      track.playback.laneOffsetM = spec.laneOffsetM ?? 0;
      track.to = target;
    } else if (moved) {
      const current =
        track.duration > 0
          ? lerp(track.from, track.to, Math.min(1, (now - track.t0) / track.duration))
          : track.to;
      if (spec.interpolateMs && spec.interpolateMs > 0) {
        track.from = current;
        track.to = target;
        track.t0 = now;
        track.duration = spec.interpolateMs;
      } else {
        track.from = target;
        track.to = target;
        track.duration = 0;
        this.place(track, target);
      }
    }
    if (spec.icon !== prev.icon) track.billboard.setImage(spec.icon, getIcon(spec.icon));
    if (spec.scale !== prev.scale) track.billboard.scale = spec.scale ?? 1;
    if (!track.playback && spec.heading !== prev.heading) {
      track.heading = spec.heading;
      this.applyHeading(track);
    }
    track.stale = isStale(spec, wallNow);
    if (spec.color !== prev.color || track.stale !== isStale(prev, wallNow)) this.applyColor(track);
    if (spec.label !== prev.label || spec.labelMaxDistance !== prev.labelMaxDistance) {
      this.applyLabel(track, track.billboard.position);
    }
    track.billboard.id = spec.pick;
  }

  private place(track: Track, pos: Position): void {
    const cartesian = Cartesian3.fromDegrees(pos.lon, pos.lat, pos.alt, undefined, this.scratch);
    track.billboard.position = cartesian;
    if (track.label) track.label.position = cartesian;
  }

  private applyHeading(track: Track): void {
    const { heading } = track;
    if (heading === undefined) {
      track.billboard.rotation = 0;
      track.billboard.alignedAxis = Cartesian3.ZERO;
    } else {
      track.billboard.rotation = -CesiumMath.toRadians(heading);
      track.billboard.alignedAxis = Cartesian3.UNIT_Z;
    }
  }

  private applyColor(track: Track): void {
    const alpha = track.stale ? STALE_ALPHA : 1;
    track.billboard.color = Color.fromCssColorString(track.spec.color).withAlpha(alpha);
    if (track.label) track.label.fillColor = Color.WHITE.withAlpha(alpha);
  }

  private applyLabel(track: Track, position: Cartesian3): void {
    const { label, labelMaxDistance, pick } = track.spec;
    if (!label) {
      if (track.label) this.labels.remove(track.label);
      track.label = undefined;
      return;
    }
    if (!track.label) {
      track.label = this.labels.add({
        position,
        font: '12px ui-monospace, Menlo, monospace',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        pixelOffset: LABEL_OFFSET,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: NO_DEPTH_TEST_DISTANCE,
        id: pick,
      });
    }
    track.label.text = label;
    track.label.distanceDisplayCondition = new DistanceDisplayCondition(
      0,
      labelMaxDistance ?? 50_000,
    );
    track.label.fillColor = Color.WHITE.withAlpha(track.stale ? STALE_ALPHA : 1);
  }
}
