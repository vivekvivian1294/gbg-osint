import type { ClientConfig, Feature, Frame, LonLat, Track } from '@gbg-osint/shared';
import {
  Cartesian2,
  Cartographic,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type CesiumWidget,
} from 'cesium';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { BasemapId, StyleId } from '../config';
import { BuildingLayer } from '../engine/buildings';
import type { CameraState } from '../engine/cameraState';
import { DistrictLayer } from '../engine/districts';
import { createGlobe, getCameraState, setBasemap, setCameraState } from '../engine/globe';
import { HistoryTrailLayer } from '../engine/historyTrail';
import type { MarkerSpec, PickRef } from '../engine/markerSpec';
import { MarkerRenderer } from '../engine/markers';
import { Overlay, type OverlayStats } from '../engine/overlay';
import { RadarLayer, type RadarState } from '../engine/radar';
import { NoiseLayer } from '../engine/noise';
import type { TunnelMask } from '../engine/tunnels';
import { SatelliteLayer } from '../engine/satellite';
import { captureView } from '../engine/screenshot';
import { Ground, TerrainController } from '../engine/terrain';
import { StyleController } from '../engine/styles';
import { ToolLayer, type Drawing } from '../engine/tools';
import { TourPlayer, type Tour, type TourState } from '../engine/tours';
import { CameraTracker } from '../engine/tracker';
import { TrafficLayer } from '../engine/traffic';
import { TravelTimeLayer } from '../engine/travelTimes';
import { TransitRouteLayer } from '../engine/transitRoutes';
import { WindLayer } from '../engine/wind';
import type { WindField } from '../layers/wind';
import { ViewshedLayer, type ViewCamera } from '../engine/viewsheds';
import { WaterwayLayer } from '../engine/waterways';
import type { TrackRef } from '../layers/contacts';
import type { DistrictShape } from '../layers/districts';
import type { ViewBounds } from '../state/feedFilter';
import type { Store } from '../state/store';

export interface GlobeHandle {
  flyTo(camera: CameraState): void;
  playTour(tour: Tour): void;
  stopTour(): void;
  radarPlay(playing: boolean): void;
  radarSeek(index: number): void;
  /** The ground point at the centre of the view, if the globe is there. */
  centre(): LonLat | null;
  /** A PNG of the view with `note` and the map credits in a footer. */
  screenshot(note: string): Promise<Blob | null>;
}

/** Line features of one active layer; `version` changes whenever the features do. */
export interface FeatureSet {
  layerId: string;
  channel: string;
  version: number;
  features: readonly Feature[];
}

export interface RadarFrames {
  version: number;
  frames: readonly Frame[];
}

export interface CameraViews {
  version: number;
  cameras: readonly ViewCamera[];
}

/** Coloured district polygons; `key` changes with the data or the chosen statistic. */
export interface DistrictFill {
  key: string;
  layerId: string;
  channel: string;
  shapes: readonly DistrictShape[];
}

/** Overlay colour that stays legible on top of each sensor style. */
const OVERLAY_COLORS: Record<StyleId, string> = {
  normal: '#5eead4',
  crt: '#9effc4',
  nvg: '#8cff9e',
  flir: '#ffffff',
  ironbow: '#ffd166',
  noir: '#f5f5f5',
};

const STATS_INTERVAL_MS = 500;
const BUILDING_REFRESH_MS = 1_000;
const LONG_PRESS_MS = 600;
const LONG_PRESS_SLOP_PX = 10;

function groundAt(globe: CesiumWidget, position: Cartesian2): LonLat | null {
  const { scene, camera } = globe;
  const ray = camera.getPickRay(position);
  // With terrain the click lands on the hills, not on the ellipsoid beneath them.
  const ground =
    (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(position) ?? undefined;
  if (!ground) return null;
  const c = Cartographic.fromCartesian(ground);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}

function viewCentre(globe: CesiumWidget): LonLat | null {
  const canvas = globe.scene.canvas;
  return groundAt(globe, new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
}

function viewBounds(globe: CesiumWidget): ViewBounds | null {
  const r = globe.camera.computeViewRectangle();
  if (!r) return null;
  const deg = CesiumMath.toDegrees;
  return { west: deg(r.west), south: deg(r.south), east: deg(r.east), north: deg(r.north) };
}

interface GlobeViewProps {
  ref?: Ref<GlobeHandle>;
  basemap: BasemapId;
  basemapKeys: ClientConfig;
  style: StyleId;
  detection: boolean;
  density: number;
  tracked: TrackRef | null;
  initialCamera: CameraState;
  markers: readonly MarkerSpec[];
  waterways: FeatureSet | null;
  traffic: FeatureSet | null;
  travelTimes: FeatureSet | null;
  transitRoutes: FeatureSet | null;
  /** Live vehicle colours by mode and line, for the route lines. */
  lineColors: ReadonlyMap<string, string>;
  /** 24-hour path of the selected or tracked ship, aircraft or train. */
  trail: Track | null;
  wind: WindField | null;
  /** Yesterday's satellite image over the basemap. */
  satellite: boolean;
  /** The city's modelled road traffic noise over the basemap. */
  noise: boolean;
  /** Roads and rails underground, so nothing is drawn moving through buildings or hills. */
  tunnels: TunnelMask;
  /** Real terrain and 3D buildings from Cesium ion (needs `basemapKeys.cesiumIonToken`). */
  terrain: boolean;
  radar: RadarFrames | null;
  buildings: boolean;
  cameraViews: CameraViews | null;
  districts: DistrictFill | null;
  drawing: Drawing;
  /** While a map tool is active, clicks place points instead of selecting objects. */
  toolActive: boolean;
  ride: boolean;
  cameraStore: Store<CameraState>;
  statsStore: Store<OverlayStats>;
  radarStore: Store<RadarState>;
  tourStore: Store<TourState | null>;
  onCameraSettled(state: CameraState): void;
  /** The ground point at the centre of the view once the camera stops (null over the sky). */
  onCentreSettled(point: LonLat | null): void;
  /** The visible part of the globe once the camera stops (null when none is visible). */
  onViewSettled(view: ViewBounds | null): void;
  onPick(pick: PickRef | null): void;
  onMapClick(lon: number, lat: number): void;
  /** Right-click, or a long press on touch screens: "What's here?". */
  onSpot(lon: number, lat: number): void;
  onTrackLost(): void;
}

interface Engine {
  globe: CesiumWidget;
  renderer: MarkerRenderer;
  styles: StyleController;
  overlay: Overlay;
  tracker: CameraTracker;
  waterways: WaterwayLayer;
  traffic: TrafficLayer;
  travelTimes: TravelTimeLayer;
  transitRoutes: TransitRouteLayer;
  trail: HistoryTrailLayer;
  wind: WindLayer;
  satellite: SatelliteLayer;
  noise: NoiseLayer;
  ground: Ground;
  terrain: TerrainController;
  radar: RadarLayer;
  buildings: BuildingLayer;
  viewsheds: ViewshedLayer;
  tours: TourPlayer;
  districts: DistrictLayer;
  tools: ToolLayer;
}

const featureKey = (set: FeatureSet | null) => (set ? `${set.channel}:${set.version}` : 'off');

export function GlobeView(props: GlobeViewProps) {
  const { ref, basemap, style, detection, density, tracked, markers, buildings, ride, drawing } =
    props;
  const waterwaysKey = featureKey(props.waterways);
  const tunnelsKey = props.tunnels.id;
  const trafficKey = `${featureKey(props.traffic)}|${tunnelsKey}`;
  const travelTimesKey = `${featureKey(props.travelTimes)}|${tunnelsKey}`;
  const transitRoutesKey = `${featureKey(props.transitRoutes)}|${[...props.lineColors].sort().join()}|${tunnelsKey}`;
  const trailKey = props.trail
    ? `${props.trail.key}:${props.trail.points.length}:${props.trail.points.at(-1)?.[0] ?? 0}`
    : 'off';
  const radarKey = props.radar ? props.radar.version : 'off';
  const viewsKey = props.cameraViews ? props.cameraViews.version : 'off';
  const districtsKey = props.districts ? props.districts.key : 'off';
  const containerRef = useRef<HTMLDivElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const windRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const initial = useRef({ basemap, camera: props.initialCamera });
  const currentBasemap = useRef(basemap);
  const latest = useRef(props);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const container = containerRef.current;
    const credits = creditsRef.current;
    const canvas = overlayRef.current;
    const windCanvas = windRef.current;
    if (!container || !credits || !canvas || !windCanvas) return;
    const globe = createGlobe(
      container,
      credits,
      initial.current.basemap,
      latest.current.basemapKeys,
    );
    currentBasemap.current = initial.current.basemap;
    setCameraState(globe, initial.current.camera);
    const ground = new Ground(globe);
    const renderer = new MarkerRenderer(globe.scene, ground);
    const engine: Engine = {
      globe,
      ground,
      renderer,
      styles: new StyleController(globe.scene),
      overlay: new Overlay(canvas, globe.scene, renderer),
      tracker: new CameraTracker(globe.scene, renderer),
      waterways: new WaterwayLayer(globe.scene),
      traffic: new TrafficLayer(globe.scene, ground),
      travelTimes: new TravelTimeLayer(globe.scene),
      transitRoutes: new TransitRouteLayer(globe.scene),
      trail: new HistoryTrailLayer(globe.scene, ground),
      wind: new WindLayer(windCanvas, globe.scene, ground),
      satellite: new SatelliteLayer(globe),
      noise: new NoiseLayer(globe),
      radar: new RadarLayer(globe, (state) => latest.current.radarStore.set(state)),
      buildings: new BuildingLayer(globe.scene, globe.creditDisplay),
      viewsheds: new ViewshedLayer(globe.scene),
      tours: new TourPlayer((state) => latest.current.tourStore.set(state)),
      districts: new DistrictLayer(globe.scene),
      tools: new ToolLayer(globe.scene, ground),
      terrain: new TerrainController(globe, ground, () => refreshHeights()),
    };
    engineRef.current = engine;
    latest.current.onCentreSettled(viewCentre(globe));
    latest.current.onViewSettled(viewBounds(globe));
    const refreshHeights = () => {
      renderer.refreshHeights();
      engine.tools.refreshHeights();
      engine.trail.refreshHeights();
      engine.buildings.setEnabled(latest.current.buildings && !ground.terrain);
    };

    const { camera, scene } = globe;
    camera.percentageChanged = 0.001;
    let lastStats = 0;
    let lastBuildingRefresh = 0;
    const removers = [
      camera.changed.addEventListener(() => latest.current.cameraStore.set(getCameraState(globe))),
      camera.moveEnd.addEventListener(() => {
        latest.current.onCameraSettled(getCameraState(globe));
        latest.current.onCentreSettled(viewCentre(globe));
        latest.current.onViewSettled(viewBounds(globe));
        engine.viewsheds.update();
      }),
      scene.postRender.addEventListener(() => {
        const stats = engine.overlay.draw();
        const now = performance.now();
        if (now - lastStats >= STATS_INTERVAL_MS) {
          lastStats = now;
          latest.current.statsStore.set(stats);
        }
      }),
      // Finer terrain tiles change the surface a little: re-seat what sits on it.
      scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        if (queued === 0 && ground.refresh(performance.now())) refreshHeights();
      }),
    ];

    const handler = new ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      if (latest.current.toolActive) {
        const p = groundAt(globe, e.position);
        if (p) latest.current.onMapClick(p[0], p[1]);
        return;
      }
      const picked: unknown = scene.pick(e.position);
      latest.current.onPick(renderer.resolvePick(picked) ?? engine.traffic.pickOf(picked) ?? null);
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const p = groundAt(globe, e.position);
      if (p) latest.current.onSpot(p[0], p[1]);
    }, ScreenSpaceEventType.RIGHT_CLICK);
    const noMenu = (e: Event) => e.preventDefault();
    scene.canvas.addEventListener('contextmenu', noMenu);

    // A still finger held down asks "What's here?"; any movement or a second finger cancels.
    const touches = new Map<number, { x: number; y: number }>();
    let pressTimer: number | undefined;
    const cancelPress = () => window.clearTimeout(pressTimer);
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelPress();
      if (touches.size !== 1) return;
      pressTimer = window.setTimeout(() => {
        const rect = scene.canvas.getBoundingClientRect();
        const p = groundAt(globe, new Cartesian2(e.clientX - rect.left, e.clientY - rect.top));
        if (p) latest.current.onSpot(p[0], p[1]);
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (e: PointerEvent) => {
      const start = touches.get(e.pointerId);
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) {
        cancelPress();
      }
    };
    const onPointerEnd = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      cancelPress();
    };
    scene.canvas.addEventListener('pointerdown', onPointerDown);
    scene.canvas.addEventListener('pointermove', onPointerMove);
    scene.canvas.addEventListener('pointerup', onPointerEnd);
    scene.canvas.addEventListener('pointercancel', onPointerEnd);
    // Any drag or zoom hands the camera back to the user.
    const stopTour = () => engine.tours.stop();
    scene.canvas.addEventListener('pointerdown', stopTour);
    scene.canvas.addEventListener('wheel', stopTour, { passive: true });

    let frame = requestAnimationFrame(function loop() {
      const now = performance.now();
      const tourCamera = engine.tours.frame(now);
      if (tourCamera) setCameraState(globe, tourCamera);
      const moved = renderer.tick(now);
      const flowing = engine.waterways.update(now);
      const driving = engine.traffic.update(now);
      const raining = engine.radar.update(now);
      if (now - lastBuildingRefresh >= BUILDING_REFRESH_MS) {
        lastBuildingRefresh = now;
        engine.buildings.refresh();
      }
      const building = engine.buildings.update();
      const districting = engine.districts.update();
      const draping = engine.travelTimes.update() || engine.transitRoutes.update();
      engine.wind.update(now);
      const tracking = engine.tracker.update();
      if (tracking === 'lost') latest.current.onTrackLost();
      if (
        moved ||
        flowing ||
        driving ||
        raining ||
        building ||
        districting ||
        draping ||
        tourCamera ||
        tracking === 'following' ||
        engine.styles.animated
      ) {
        scene.requestRender();
      }
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(frame);
      handler.destroy();
      cancelPress();
      scene.canvas.removeEventListener('contextmenu', noMenu);
      scene.canvas.removeEventListener('pointerdown', onPointerDown);
      scene.canvas.removeEventListener('pointermove', onPointerMove);
      scene.canvas.removeEventListener('pointerup', onPointerEnd);
      scene.canvas.removeEventListener('pointercancel', onPointerEnd);
      scene.canvas.removeEventListener('pointerdown', stopTour);
      scene.canvas.removeEventListener('wheel', stopTour);
      for (const remove of removers) remove();
      engine.tours.stop();
      engine.tracker.stop();
      engine.styles.destroy();
      engine.waterways.clear();
      engine.traffic.destroy();
      engine.travelTimes.destroy();
      engine.transitRoutes.destroy();
      engine.trail.destroy();
      engine.wind.set(null);
      engine.satellite.hide();
      engine.noise.hide();
      engine.terrain.destroy();
      engine.radar.clear();
      engine.buildings.destroy();
      engine.viewsheds.clear();
      engine.districts.clear();
      engine.tools.destroy();
      renderer.destroy();
      globe.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.renderer.sync(markers);
  }, [markers]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const set = latest.current.waterways;
    if (set) engine.waterways.set(set.features);
    else engine.waterways.clear();
  }, [waterwaysKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const set = latest.current.traffic;
    if (set) engine.traffic.set(set.layerId, set.channel, set.features, latest.current.tunnels);
    else engine.traffic.clear();
  }, [trafficKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const set = latest.current.travelTimes;
    if (set) {
      engine.travelTimes.set(set.layerId, set.channel, set.features, latest.current.tunnels);
    } else engine.travelTimes.clear();
  }, [travelTimesKey]);

  useEffect(() => {
    engineRef.current?.renderer.setTunnels(props.tunnels);
  }, [props.tunnels]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const set = latest.current.transitRoutes;
    if (set) {
      engine.transitRoutes.set(
        set.layerId,
        set.channel,
        set.features,
        latest.current.lineColors,
        latest.current.tunnels,
      );
    } else engine.transitRoutes.clear();
  }, [transitRoutesKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const trail = latest.current.trail;
    if (trail) engine.trail.set(trail);
    else engine.trail.clear();
  }, [trailKey]);

  useEffect(() => {
    engineRef.current?.wind.set(props.wind);
  }, [props.wind]);

  useEffect(() => {
    const engine = engineRef.current;
    if (props.satellite) engine?.satellite.show();
    else engine?.satellite.hide();
  }, [props.satellite]);

  useEffect(() => {
    const engine = engineRef.current;
    if (props.noise) engine?.noise.show();
    else engine?.noise.hide();
  }, [props.noise]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const radar = latest.current.radar;
    if (radar) engine.radar.set(radar.frames);
    else engine.radar.clear();
  }, [radarKey]);

  // With terrain, Cesium OSM Buildings (terrain-aware) replace the flat-based OpenFreeMap ones.
  const ionToken = props.basemapKeys.cesiumIonToken;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.buildings.setEnabled(buildings && !(props.terrain && ionToken));
    void engine.terrain.set(props.terrain, ionToken, buildings);
  }, [buildings, props.terrain, ionToken]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const views = latest.current.cameraViews;
    if (views) engine.viewsheds.set(views.cameras);
    else engine.viewsheds.clear();
    engine.globe.scene.requestRender();
  }, [viewsKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const fill = latest.current.districts;
    if (!fill) {
      engine.districts.clear();
      return;
    }
    const { layerId, channel } = fill;
    engine.districts.set(fill.key, fill.shapes, (id) => ({ layerId, channel, ids: [id] }));
  }, [districtsKey]);

  useEffect(() => {
    engineRef.current?.tools.set(drawing);
  }, [drawing]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || currentBasemap.current === basemap) return;
    currentBasemap.current = basemap;
    setBasemap(engine.globe, basemap, latest.current.basemapKeys);
  }, [basemap]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.styles.set(style);
    engine.overlay.options = {
      ...engine.overlay.options,
      detection,
      density,
      color: OVERLAY_COLORS[style],
    };
    engine.globe.scene.requestRender();
  }, [style, detection, density]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { renderer, tracker, overlay } = engine;
    if (!tracked) {
      tracker.stop();
      overlay.options = { ...overlay.options, trackedKey: null };
      return;
    }
    const key = renderer.findKey(tracked.layerId, tracked.id);
    if (!key || key === tracker.trackedKey) return;
    engine.tours.stop();
    if (tracker.start(key, renderer.specOf(key)?.trackRange ?? 2_000)) {
      overlay.options = { ...overlay.options, trackedKey: key };
    }
  }, [tracked, markers]);

  useEffect(() => {
    engineRef.current?.tracker.setView(ride && tracked ? 'cab' : 'chase');
  }, [ride, tracked]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(camera) {
        const engine = engineRef.current;
        if (!engine) return;
        engine.tours.stop();
        engine.tracker.stop();
        setCameraState(engine.globe, camera, true);
      },
      playTour(tour) {
        const engine = engineRef.current;
        if (!engine) return;
        engine.tracker.stop();
        engine.globe.camera.cancelFlight();
        engine.tours.play(tour, performance.now());
      },
      stopTour() {
        engineRef.current?.tours.stop();
      },
      radarPlay(playing) {
        engineRef.current?.radar.play(playing);
      },
      radarSeek(index) {
        engineRef.current?.radar.seek(index);
      },
      centre() {
        const engine = engineRef.current;
        return engine ? viewCentre(engine.globe) : null;
      },
      screenshot(note) {
        const engine = engineRef.current;
        if (!engine) return Promise.resolve(null);
        const container = creditsRef.current;
        const shown =
          container?.querySelector<HTMLElement>('.cesium-credit-textContainer') ?? container;
        const mapCredits = (shown?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const overlays = [windRef.current, overlayRef.current].filter(
          (c): c is HTMLCanvasElement => c !== null,
        );
        return captureView(
          engine.globe.scene,
          overlays,
          [note, mapCredits].filter(Boolean).join(' · '),
        );
      },
    }),
    [],
  );

  return (
    <>
      <div ref={containerRef} className="globe" />
      <canvas ref={windRef} className="globe-overlay" aria-hidden="true" />
      <canvas ref={overlayRef} className="globe-overlay" aria-hidden="true" />
      <div ref={creditsRef} className="globe-credits" />
    </>
  );
}
