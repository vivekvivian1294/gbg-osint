import {
  ClientConfigSchema,
  isArea,
  isDeparture,
  isEntity,
  isEvent,
  isFeature,
  isFrame,
  isMetric,
  TRACK_CHANNELS,
  type BriefTarget,
  type ChannelItem,
  type ChannelKind,
  type ClientConfig,
  type LonLat,
  type RadioStation,
} from '@gbg-osint/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BoardsPanel } from './components/BoardsPanel';
import { BriefPanel } from './components/BriefPanel';
import { CameraReadout } from './components/CameraReadout';
import { Clock } from './components/Clock';
import { DistrictLegend } from './components/DistrictLegend';
import { EventFeed } from './components/EventFeed';
import {
  GlobeView,
  type CameraViews,
  type DistrictFill,
  type FeatureSet,
  type GlobeHandle,
  type RadarFrames,
} from './components/GlobeView';
import { Hud } from './components/Hud';
import { LayerPanel } from './components/LayerPanel';
import { MetricsStrip, type MetricGroup } from './components/MetricsStrip';
import { MissionsDialog } from './components/MissionsDialog';
import { RadarTimeline, TourBar } from './components/Playbars';
import { RadioPanel } from './components/RadioPanel';
import { ScenesDialog } from './components/ScenesDialog';
import { SelectionCard } from './components/SelectionCard';
import { SpotReport } from './components/SpotReport';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { StatusDialog } from './components/StatusDialog';
import { ToolsPanel, type NotificationState } from './components/ToolsPanel';
import { TopBar, type RightPanel } from './components/TopBar';
import { DEFAULT_BASEMAP, STYLE_IDS, type BasemapId, type StyleId } from './config';
import { basemapAvailable } from './engine/basemaps';
import { homeCamera, viewOf, type CameraState } from './engine/cameraState';
import type { PickRef } from './engine/markerSpec';
import type { OverlayStats } from './engine/overlay';
import type { RadarState } from './engine/radar';
import type { Tour, TourKeyframe, TourState } from './engine/tours';
import {
  buildRoster,
  distanceKm,
  trackableEntities,
  type Contact,
  type TrackRef,
} from './layers/contacts';
import { buildMarkers, lineKey } from './layers/markers';
import { classifyDistricts, DEFAULT_DISTRICT_METRIC } from './layers/districts';
import { formatDistance } from './layers/measure';
import { buildWindField, compass, windAt } from './layers/wind';
import {
  DEFAULT_LAYERS,
  LAYERS,
  LAYER_BY_ID,
  LOCAL_CHANNELS,
  layerAvailability,
} from './layers/registry';
import type { Mission } from './missions';
import type { SearchResult } from './search/search';
import { fetchJson } from './state/api';
import { useCatalog, useLive } from './state/hooks';
import { useTrack } from './state/history';
import { LiveClient } from './state/live';
import { createStore } from './state/store';
import { useStreetPhotos } from './state/streetPhotos';
import { useTools } from './state/tools';
import { useSpot } from './state/spot';
import { Watcher, watchChannels, type WatchAlert } from './state/watch';
import { NO_FILTER, type FeedFilter, type ViewBounds } from './state/feedFilter';
import { parseHash, writeHash, type UrlState } from './state/urlState';
import { addKeyframe, loadRecording, recordedTour, routeTour, saveRecording } from './tours';

const ROUTE_TOUR_TITLES = { foot: 'Walk', bike: 'Bike ride', car: 'Drive' } as const;

const WIDE_SCREEN_QUERY = '(min-width: 900px)';
const VISITED_KEY = 'gbg-osint:visited';
const DENSITIES: readonly number[] = [1, 0.5, 0.25];
const SEARCH_VIEW_HEIGHT_M = 2500;
const BRIEF_VIEW_HEIGHT_M = 3000;
const TOAST_MS = 2500;
const MAX_ALERTS = 30;
/** Browser notifications per batch; the rest are listed in the Watch tool. */
const MAX_NOTIFICATIONS = 3;
const PHOTO_CHANNEL = 'photos.street';
/** Layers whose objects have a sensible cab or bow view. */
const RIDE_LAYERS = new Set(['transit', 'ships', 'aircraft']);

type DialogId = 'status' | 'missions' | 'scenes' | 'help';

function wsUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

function hasVisited(): boolean {
  try {
    return localStorage.getItem(VISITED_KEY) === '1';
  } catch {
    return true;
  }
}

function markVisited(): void {
  try {
    localStorage.setItem(VISITED_KEY, '1');
  } catch {
    // Storage can be unavailable (private mode); the missions dialog just shows again next time.
  }
}

const sameRef = (a: TrackRef, b: TrackRef) => a.layerId === b.layerId && a.id === b.id;
const toRef = (c: Contact): TrackRef => ({ layerId: c.layerId, id: c.id });
const enabledFrom = (layers: readonly string[]) =>
  new Set(layers.filter((id) => LAYER_BY_ID.has(id)));

export function App() {
  const [initial] = useState(() => parseHash(window.location.hash));
  const [initialCamera] = useState(() => initial.camera ?? homeCamera());
  const [cameraStore] = useState(() => createStore<CameraState>(initialCamera));
  const [statsStore] = useState(() =>
    createStore<OverlayStats>({ contactsInView: 0, markersInView: 0 }),
  );
  const [radarStore] = useState(() =>
    createStore<RadarState>({ count: 0, index: 0, ts: null, latest: null, playing: true }),
  );
  const [tourStore] = useState(() => createStore<TourState | null>(null));
  const [recording, setRecording] = useState<TourKeyframe[]>(loadRecording);
  const [camera, setCamera] = useState<CameraState>(initialCamera);
  const [basemap, setBasemap] = useState<BasemapId>(initial.basemap ?? DEFAULT_BASEMAP);
  const [style, setStyle] = useState<StyleId>(initial.style ?? 'normal');
  const [hud, setHud] = useState(initial.hud ?? false);
  const [detection, setDetection] = useState(initial.detection ?? false);
  const [terrain, setTerrain] = useState(initial.terrain ?? false);
  const [density, setDensity] = useState(1);
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(() =>
    enabledFrom(initial.layers ?? DEFAULT_LAYERS),
  );
  const [panels, setPanels] = useState<{ layers: boolean; right: RightPanel | null }>(() => {
    const wide = window.matchMedia(WIDE_SCREEN_QUERY).matches;
    return { layers: wide, right: wide ? 'feed' : null };
  });
  const [dialog, setDialog] = useState<DialogId | null>(() =>
    !window.location.hash && !hasVisited() ? 'missions' : null,
  );
  const [selection, setSelection] = useState<PickRef | null>(null);
  const [tracked, setTracked] = useState<TrackRef | null>(initial.track ?? null);
  const [ride, setRide] = useState(initial.ride ?? false);
  const [districtMetric, setDistrictMetric] = useState(DEFAULT_DISTRICT_METRIC);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [radio, setRadio] = useState<RadioStation | null>(null);
  const tools = useTools();
  const [rosterRefs, setRosterRefs] = useState<TrackRef[] | null>(null);
  const [toast, setToast] = useState('');
  const [spot, setSpot] = useState<LonLat | null>(null);
  const [centre, setCentre] = useState<LonLat | null>(null);
  const [view, setView] = useState<ViewBounds | null>(null);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>(NO_FILTER);
  const spotData = useSpot(spot);
  const [watcher] = useState(() => new Watcher());
  const [alerts, setAlerts] = useState<WatchAlert[]>([]);
  const [notifications, setNotifications] = useState<NotificationState>(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );
  const toastTimer = useRef<number | undefined>(undefined);
  const globeRef = useRef<GlobeHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [live] = useState(() => new LiveClient(wsUrl()));
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);
  const { connection } = useLive(live);
  const catalog = useCatalog();

  const [clientKeys, setClientKeys] = useState<ClientConfig>({});
  useEffect(() => {
    const controller = new AbortController();
    fetchJson('/api/client-config', ClientConfigSchema, controller.signal).then(
      setClientKeys,
      () => undefined,
    );
    return () => controller.abort();
  }, []);
  // Keyed basemaps fall back to the default until (or unless) the server provides a key.
  const shownBasemap = basemapAvailable(basemap, clientKeys) ? basemap : DEFAULT_BASEMAP;

  const sources = useMemo(() => new Map(catalog.sources.map((s) => [s.id, s])), [catalog.sources]);
  const channelKinds = useMemo(
    () =>
      new Map<string, ChannelKind>([
        ...catalog.channels.map((c): [string, ChannelKind] => [c.name, c.kind]),
        ...LOCAL_CHANNELS,
      ]),
    [catalog.channels],
  );
  const activeLayers = useMemo(
    () =>
      LAYERS.filter((l) => enabled.has(l.id) && layerAvailability(l, sources).kind === 'available'),
    [enabled, sources],
  );
  const activeChannels = useMemo(
    () => [...new Set(activeLayers.flatMap((l) => l.channels))],
    [activeLayers],
  );
  const liveChannels = useMemo(
    () => activeChannels.filter((c) => !LOCAL_CHANNELS.has(c)),
    [activeChannels],
  );
  const isActive = (layerId: string) => activeLayers.some((l) => l.id === layerId);
  const photos = useStreetPhotos(isActive('street-photos'), camera);

  const watching = tools.watchAreas.length > 0;
  const watchList = useMemo(
    () => (watching ? watchChannels(channelKinds) : []),
    [watching, channelKinds],
  );
  const subscribed = useMemo(
    () => [...new Set([...liveChannels, ...watchList])],
    [liveChannels, watchList],
  );

  useEffect(() => {
    live.setChannels(subscribed);
  }, [live, subscribed]);

  // Watch areas are checked whenever a watched channel changes, outside React's render.
  const watchState = useRef({ areas: tools.watchAreas, channels: watchList });
  const onAlerts = useRef<(found: WatchAlert[]) => void>(() => undefined);
  useEffect(() => {
    watchState.current = { areas: tools.watchAreas, channels: watchList };
  });
  useEffect(() => {
    let lastKey = '';
    return live.subscribe(() => {
      const { areas, channels } = watchState.current;
      if (areas.length === 0) return;
      const loaded = channels.filter((c) => live.loaded(c));
      const key = `${areas.map((a) => a.id).join()}|${loaded.map((c) => `${c}:${live.version(c)}`).join()}`;
      if (key === lastKey) return;
      lastKey = key;
      const found = watcher.update(
        areas,
        loaded.map((channel) => ({ channel, items: live.items(channel) })),
        Date.now(),
      );
      if (found.length > 0) onAlerts.current(found);
    });
  }, [live, watcher]);

  useEffect(() => {
    writeHash({
      camera,
      basemap,
      layers: [...enabled],
      style,
      hud,
      detection,
      terrain,
      ...(tracked && { track: tracked, ride }),
    });
  }, [camera, basemap, enabled, style, hud, detection, terrain, tracked, ride]);

  // Derived from live data on every render; useLive re-renders this component on updates.
  const itemsOf = (channel: string): ChannelItem[] =>
    channel === PHOTO_CHANNEL ? [...photos] : live.items(channel);
  const markers = buildMarkers(activeLayers, channelKinds, itemsOf);
  const featureSet = (layerId: string): FeatureSet | null => {
    const channel = activeLayers.find((l) => l.id === layerId)?.channels[0];
    if (!channel || channelKinds.get(channel) !== 'features') return null;
    return {
      layerId,
      channel,
      version: live.version(channel),
      features: itemsOf(channel).filter(isFeature),
    };
  };
  const radarFrames: RadarFrames | null = isActive('radar')
    ? { version: live.version('env.radar'), frames: itemsOf('env.radar').filter(isFrame) }
    : null;
  const cameraViews: CameraViews | null = isActive('road-cameras')
    ? {
        version: live.version('cameras.road'),
        cameras: itemsOf('cameras.road')
          .filter(isEntity)
          .flatMap((e) =>
            e.heading === undefined
              ? []
              : [{ id: e.id, lon: e.lon, lat: e.lat, heading: e.heading }],
          ),
      }
    : null;

  const windVersion = isActive('wind') ? live.version('env.wind') : -1;
  const lineColors = new Map<string, string>();
  if (isActive('transit-routes')) {
    for (const e of itemsOf('transit.vehicles').filter(isEntity)) {
      const color = e.props?.color;
      if (typeof color === 'string') lineColors.set(lineKey(e.props?.mode, e.props?.line), color);
    }
  }
  const wind = useMemo(
    () => (windVersion < 0 ? null : buildWindField(live.items('env.wind'))),
    [live, windVersion],
  );
  const centreWind = wind && centre ? windAt(wind, centre[0], centre[1]) : undefined;

  const districtsVersion = isActive('districts') ? live.version('context.districts') : -1;
  const districts = useMemo(() => {
    if (districtsVersion < 0) return null;
    const areas = live.items('context.districts').filter(isArea);
    return areas.length > 0 ? classifyDistricts(areas, districtMetric) : null;
  }, [live, districtsVersion, districtMetric]);
  const districtFill: DistrictFill | null = districts && {
    key: `${districtsVersion}:${districts.metric.id}`,
    layerId: 'districts',
    channel: 'context.districts',
    shapes: districts.shapes,
  };

  const eventChannels = activeChannels.filter((c) => channelKinds.get(c) === 'events');
  const events = eventChannels
    .flatMap(itemsOf)
    .filter(isEvent)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  const metricGroups: MetricGroup[] = activeLayers
    .filter((l) => l.channels.some((c) => channelKinds.get(c) === 'metrics'))
    .map((l) => ({
      layerId: l.id,
      label: l.label,
      ...(l.note && { note: l.note }),
      channels: l.channels.filter((c) => channelKinds.get(c) === 'metrics'),
      metrics: l.channels.flatMap(itemsOf).filter(isMetric),
    }));

  const boardChannels = activeChannels.filter((c) => channelKinds.get(c) === 'departures');
  const boardRows = boardChannels.flatMap(itemsOf).filter(isDeparture);
  const boardNotes = new Map<string, string>();
  const landvetter = isActive('airport-weather')
    ? itemsOf('aviation.metar').find((i) => i.id === 'ESGG')
    : undefined;
  if (landvetter && isEntity(landvetter) && typeof landvetter.props?.metar === 'string') {
    boardNotes.set('Göteborg Landvetter (GOT)', landvetter.props.metar);
  }

  const trackables = trackableEntities(activeLayers, itemsOf);
  const findContact = (ref: TrackRef) => trackables.find((c) => sameRef(c, ref));
  const trackedContact = tracked ? findContact(tracked) : undefined;
  const roster: Contact[] = !trackedContact
    ? []
    : rosterRefs
      ? rosterRefs.flatMap((ref) => {
          const c = findContact(ref);
          return c ? [{ ...c, distanceKm: distanceKm(trackedContact.entity, c.entity) }] : [];
        })
      : buildRoster(trackedContact, trackables);

  const cardSelection: PickRef | null =
    selection ??
    (trackedContact
      ? {
          layerId: trackedContact.layerId,
          channel: trackedContact.channel,
          ids: [trackedContact.id],
        }
      : null);
  const selectedItems = cardSelection
    ? itemsOf(cardSelection.channel).filter((i) => cardSelection.ids.includes(i.id))
    : [];
  const selectedId = cardSelection?.ids.length === 1 ? cardSelection.ids[0] : undefined;
  const selectedContact =
    cardSelection && selectedId !== undefined
      ? findContact({ layerId: cardSelection.layerId, id: selectedId })
      : undefined;

  const searchEntities = trackables.map((c) => ({
    layerId: c.layerId,
    id: c.id,
    label: c.entity.label ?? c.id,
    kind: c.entity.kind,
  }));

  const aircraftByCallsign = new Map<string, TrackRef>();
  const shipsById = new Map<string, TrackRef>();
  for (const c of trackables) {
    const callsign = c.entity.props?.callsign;
    if (c.layerId === 'aircraft' && typeof callsign === 'string') {
      aircraftByCallsign.set(callsign.toUpperCase(), toRef(c));
    }
    if (c.layerId === 'ships') shipsById.set(c.id, toRef(c));
  }

  const feeds = {
    ok: catalog.sources.filter((s) => s.state === 'ok').length,
    total: catalog.sources.filter((s) => s.state !== 'disabled').length,
  };

  const trailOf: TrackRef | null =
    tracked ??
    (selection?.ids.length === 1 ? { layerId: selection.layerId, id: selection.ids[0]! } : null);
  const trailChannel = trailOf
    ? LAYER_BY_ID.get(trailOf.layerId)?.channels.find((c) => TRACK_CHANNELS.has(c))
    : undefined;
  const trail = useTrack(trailChannel ?? null, trailChannel && trailOf ? trailOf.id : null);

  const track = (ref: TrackRef) => {
    setRosterRefs(null);
    setTracked(ref);
    setSelection(null);
  };
  const stopTracking = () => {
    setTracked(null);
    setRosterRefs(null);
    setRide(false);
  };
  const toggleTrack = () => {
    if (selectedContact && !(tracked && sameRef(tracked, selectedContact))) track(selectedContact);
    else stopTracking();
  };
  const toggleRide = () => {
    if (ride) {
      setRide(false);
      return;
    }
    const target = tracked ?? (selectedContact && toRef(selectedContact));
    if (!target || !RIDE_LAYERS.has(target.layerId)) {
      showToast('Select a tram, bus, ferry, ship or aircraft to ride along');
      return;
    }
    if (!tracked) track(target);
    setRide(true);
  };
  const stepContacts = (dir: 1 | -1) => {
    if (!tracked || roster.length < 2) return;
    const refs = roster.map(toRef);
    const index = refs.findIndex((r) => sameRef(r, tracked));
    const next = refs[(index + dir + refs.length) % refs.length];
    if (!next) return;
    setRosterRefs(refs);
    setTracked(next);
    setSelection(null);
  };
  const flyTo = (target: CameraState) => {
    stopTracking();
    globeRef.current?.flyTo(target);
  };
  const resetView = () => flyTo(homeCamera());
  const showTarget = (target: BriefTarget) => {
    setSpot(null);
    const layer = LAYERS.find((l) => l.channels.includes(target.channel));
    if (layer && !enabled.has(layer.id)) toggleLayer(layer.id);
    if (target.lon !== undefined && target.lat !== undefined) {
      flyTo(viewOf(target.lon, target.lat, BRIEF_VIEW_HEIGHT_M));
    }
    if (layer && target.ids.length > 0) {
      setSelection({ layerId: layer.id, channel: target.channel, ids: target.ids });
    }
  };

  const showToast = (message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(''), TOAST_MS);
  };
  const openSpot = (point: LonLat) => {
    setSpot(point);
    setSelection(null);
  };
  const drawing = useMemo(
    () => (spot ? { ...tools.drawing, spot } : tools.drawing),
    [tools.drawing, spot],
  );
  useEffect(() => {
    onAlerts.current = (found) => {
      setAlerts((prev) => [...[...found].reverse(), ...prev].slice(0, MAX_ALERTS));
      const latest = found.at(-1)!;
      showToast(`${latest.areaName}: ${latest.text}`);
      if (notifications !== 'granted') return;
      for (const a of found.slice(0, MAX_NOTIFICATIONS)) {
        try {
          new Notification(`Watch area: ${a.areaName}`, { body: a.text, tag: a.id });
        } catch {
          // Some mobile browsers only allow notifications from a service worker.
        }
      }
    };
  });
  const enableNotifications = () => {
    if (!('Notification' in window)) return;
    void Notification.requestPermission().then(setNotifications);
  };
  const share = () => {
    navigator.clipboard.writeText(window.location.href).then(
      () => showToast('Link to this view copied'),
      () => showToast('Copy failed – use the address bar'),
    );
  };

  const closeDialog = () => {
    if (dialog === 'missions') markVisited();
    setDialog(null);
  };
  const applyMission = (m: Mission) => {
    setEnabled(enabledFrom(m.layers));
    setBasemap(m.basemap);
    setStyle(m.style);
    setHud(m.hud);
    setDetection(m.detection);
    setSelection(null);
    flyTo(m.camera);
    markVisited();
    setDialog(null);
  };
  const playTour = (tour: Tour) => {
    stopTracking();
    setSelection(null);
    if (tour.layers) setEnabled((prev) => new Set([...prev, ...enabledFrom(tour.layers ?? [])]));
    setDialog(null);
    globeRef.current?.playTour(tour);
  };
  const addView = () => {
    const next = addKeyframe(recording, cameraStore.get());
    setRecording(next);
    saveRecording(next);
    showToast(`View ${next.length} added to your tour`);
  };
  const clearRecording = () => {
    setRecording([]);
    saveRecording([]);
  };

  const onSearchSelect = (r: SearchResult) => {
    if (r.type === 'coords') flyTo(viewOf(r.lon, r.lat, SEARCH_VIEW_HEIGHT_M));
    else if (r.type === 'place') {
      flyTo(viewOf(r.place.lon, r.place.lat, r.place.height ?? SEARCH_VIEW_HEIGHT_M));
    } else track({ layerId: r.entity.layerId, id: r.entity.id });
  };

  const toggleLayer = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleRight = (panel: RightPanel) =>
    setPanels((p) => ({ ...p, right: p.right === panel ? null : panel }));

  // Links pasted into the address bar of an open tab only change the hash.
  const applyUrlState = useRef<(s: UrlState) => void>(() => undefined);
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    applyUrlState.current = (s) => {
      if (s.basemap) setBasemap(s.basemap);
      if (s.layers) setEnabled(enabledFrom(s.layers));
      setStyle(s.style ?? 'normal');
      setHud(s.hud ?? false);
      setDetection(s.detection ?? false);
      setTerrain(s.terrain ?? false);
      setSelection(null);
      if (s.track) {
        track(s.track);
        setRide(s.ride ?? false);
      } else if (s.camera) flyTo(s.camera);
    };
    onKey.current = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || dialog) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      const n = Number(e.key);
      const styleId = Number.isInteger(n) ? STYLE_IDS[n - 1] : undefined;
      if (styleId) {
        setStyle(styleId);
        return;
      }
      switch (e.key) {
        case 'h':
        case 'H':
          setHud((v) => !v);
          break;
        case 'd':
          setDetection((v) => !v);
          break;
        case 'D':
          setDetection(true);
          setDensity((d) => DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length] ?? 1);
          break;
        case 't':
        case 'T':
          toggleTrack();
          break;
        case 'c':
        case 'C':
          toggleRide();
          break;
        case 's':
        case 'S':
          setDialog('scenes');
          break;
        case 'g':
        case 'G':
          setToolsOpen((open) => {
            if (open) tools.setMode(null);
            return !open;
          });
          break;
        case 'r':
        case 'R':
          resetView();
          break;
        case 'm':
        case 'M':
          setDialog('missions');
          break;
        case 'b':
        case 'B':
          toggleRight('boards');
          break;
        case 'n':
        case 'N':
          toggleRight('brief');
          break;
        case '?':
          setDialog('help');
          break;
        case 'w':
        case 'W': {
          const centre = globeRef.current?.centre();
          if (centre) openSpot(centre);
          break;
        }
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'Escape':
          if (tools.mode) {
            tools.setMode(null);
            break;
          }
          globeRef.current?.stopTour();
          stopTracking();
          setSelection(null);
          setSpot(null);
          break;
        case 'ArrowRight':
        case 'ArrowLeft':
          if (!tracked) return;
          e.preventDefault();
          stepContacts(e.key === 'ArrowRight' ? 1 : -1);
          break;
      }
    };
  });
  useEffect(() => {
    const onHashChange = () => applyUrlState.current(parseHash(window.location.hash));
    const onKeyDown = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const insets = {
    '--left-inset': panels.layers ? '296px' : '8px',
    '--right-inset': panels.right ? '336px' : '8px',
  } as CSSProperties;

  return (
    <div className={hud ? 'app hud-on' : 'app'} style={insets}>
      <GlobeView
        ref={globeRef}
        basemap={shownBasemap}
        basemapKeys={clientKeys}
        style={style}
        detection={detection}
        density={density}
        tracked={tracked}
        initialCamera={initialCamera}
        markers={markers}
        waterways={featureSet('waterways')}
        traffic={featureSet('traffic')}
        travelTimes={featureSet('travel-times')}
        transitRoutes={featureSet('transit-routes')}
        lineColors={lineColors}
        trail={trail ?? null}
        wind={wind}
        satellite={isActive('satellite')}
        terrain={terrain}
        radar={radarFrames}
        buildings={isActive('buildings')}
        cameraViews={cameraViews}
        districts={districtFill}
        drawing={drawing}
        toolActive={toolsOpen && tools.mode !== null}
        ride={ride}
        cameraStore={cameraStore}
        statsStore={statsStore}
        radarStore={radarStore}
        tourStore={tourStore}
        onCameraSettled={setCamera}
        onCentreSettled={setCentre}
        onViewSettled={setView}
        onPick={(pick) => {
          setSelection(pick);
          setSpot(null);
        }}
        onSpot={(lon, lat) => openSpot([lon, lat])}
        onMapClick={(lon, lat) => tools.click([lon, lat])}
        onTrackLost={() => {
          stopTracking();
          showToast('Target lost from the live data');
        }}
      />
      <TopBar
        basemap={shownBasemap}
        clientKeys={clientKeys}
        style={style}
        hud={hud}
        detection={detection}
        density={density}
        connection={connection}
        layersOpen={panels.layers}
        rightPanel={panels.right}
        toolsOpen={toolsOpen}
        radioOn={radio !== null}
        searchRef={searchRef}
        searchEntities={searchEntities}
        onSearchSelect={onSearchSelect}
        onBasemapChange={setBasemap}
        onStyleChange={setStyle}
        onToggleHud={() => setHud((v) => !v)}
        onToggleDetection={() => setDetection((v) => !v)}
        terrain={terrain}
        onToggleTerrain={() => setTerrain((v) => !v)}
        onToggleLayers={() => setPanels((p) => ({ ...p, layers: !p.layers }))}
        onToggleRight={toggleRight}
        onToggleTools={() => {
          if (toolsOpen) tools.setMode(null);
          setToolsOpen(!toolsOpen);
        }}
        onOpenMissions={() => setDialog('missions')}
        onOpenScenes={() => setDialog('scenes')}
        onShare={share}
        onResetView={resetView}
        onOpenHelp={() => setDialog('help')}
        onOpenStatus={() => setDialog('status')}
      />
      <MetricsStrip groups={metricGroups} />
      {hud && (
        <Hud
          cameraStore={cameraStore}
          statsStore={statsStore}
          style={style}
          feeds={feeds}
          trackedLabel={trackedContact ? (trackedContact.entity.label ?? trackedContact.id) : null}
          live={connection === 'open'}
        />
      )}
      {panels.layers && <LayerPanel sources={sources} enabled={enabled} onToggle={toggleLayer} />}
      {panels.right && (
        <aside className="panel panel-right" aria-label="Live feed and departure boards">
          <div className="panel-tabs">
            <button
              type="button"
              aria-pressed={panels.right === 'feed'}
              onClick={() => setPanels((p) => ({ ...p, right: 'feed' }))}
            >
              Feed
            </button>
            <button
              type="button"
              aria-pressed={panels.right === 'boards'}
              onClick={() => setPanels((p) => ({ ...p, right: 'boards' }))}
            >
              Boards
            </button>
            <button
              type="button"
              aria-pressed={panels.right === 'brief'}
              onClick={() => setPanels((p) => ({ ...p, right: 'brief' }))}
            >
              Brief
            </button>
            <button
              type="button"
              aria-pressed={panels.right === 'radio'}
              onClick={() => setPanels((p) => ({ ...p, right: 'radio' }))}
            >
              Radio
            </button>
          </div>
          {panels.right === 'feed' && (
            <EventFeed
              events={events}
              hasEventLayers={eventChannels.length > 0}
              filter={feedFilter}
              onFilterChange={setFeedFilter}
              view={view}
              watchAreas={tools.watchAreas}
            />
          )}
          {panels.right === 'boards' && (
            <BoardsPanel
              rows={boardRows}
              hasBoardLayers={boardChannels.length > 0}
              aircraftByCallsign={aircraftByCallsign}
              shipsById={shipsById}
              notes={boardNotes}
              onTrack={track}
            />
          )}
          {panels.right === 'radio' && <RadioPanel playing={radio} onPlay={setRadio} />}
          {panels.right === 'brief' && <BriefPanel onShow={showTarget} />}
        </aside>
      )}
      {radio && (
        <audio
          src={radio.stream}
          autoPlay
          onError={() => {
            setRadio(null);
            showToast(`${radio.name} is not available right now`);
          }}
        />
      )}
      {toolsOpen && (
        <ToolsPanel
          tools={tools}
          watch={{
            alerts,
            notifications,
            onEnableNotifications: enableNotifications,
            onShowAlert: (a) =>
              showTarget({ channel: a.channel, ids: [a.itemId], lon: a.lon, lat: a.lat }),
          }}
          onFlyRoute={() => {
            const result = tools.route.result;
            const tour =
              result &&
              routeTour(
                tools.drawing.routeLine,
                cameraStore.get(),
                `${ROUTE_TOUR_TITLES[result.profile]} · ${formatDistance(result.distanceM)}`,
              );
            if (tour) playTour(tour);
            else showToast('The route is too short to fly');
          }}
          onClose={() => {
            tools.setMode(null);
            setToolsOpen(false);
          }}
        />
      )}
      {districts && <DistrictLegend classes={districts} onMetricChange={setDistrictMetric} />}
      {spot && (
        <SpotReport
          key={spot.join()}
          point={spot}
          data={spotData}
          onShow={showTarget}
          onRouteFrom={() => {
            tools.routeFrom(spot);
            setToolsOpen(true);
            setSpot(null);
          }}
          onPin={() => {
            tools.addPin(spot);
            showToast('Pin dropped (Tools › Pins)');
          }}
          onClose={() => setSpot(null)}
        />
      )}
      {!spot && cardSelection && (
        <SelectionCard
          selection={cardSelection}
          items={selectedItems}
          onShow={showTarget}
          {...(selectedContact && {
            tracking: {
              trackable: true,
              tracking: Boolean(tracked && sameRef(tracked, selectedContact)),
              contacts: roster,
              onToggle: toggleTrack,
              onPickContact: (c) => track(toRef(c)),
              ...(RIDE_LAYERS.has(selectedContact.layerId) && {
                ride: { active: ride, onToggle: toggleRide },
              }),
            },
          })}
          onClose={() => {
            stopTracking();
            setSelection(null);
          }}
        />
      )}
      <footer className="bottombar">
        <CameraReadout store={cameraStore} />
        {centreWind && (
          <span
            className="wind-readout"
            title={`Open-Meteo model wind at the centre of the view${centreWind.gust !== undefined ? `; gusts ${centreWind.gust.toFixed(1)} m/s` : ''}`}
          >
            WIND {centreWind.speed.toFixed(1)} m/s {compass(centreWind.fromDeg)}
          </span>
        )}
        <Clock />
      </footer>
      {radarFrames && (
        <RadarTimeline
          store={radarStore}
          onPlay={(playing) => globeRef.current?.radarPlay(playing)}
          onSeek={(index) => globeRef.current?.radarSeek(index)}
        />
      )}
      <TourBar store={tourStore} onStop={() => globeRef.current?.stopTour()} />
      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
      <StatusDialog
        open={dialog === 'status'}
        onClose={closeDialog}
        sources={catalog.sources}
        catalogError={catalog.error}
        connection={connection}
      />
      <MissionsDialog open={dialog === 'missions'} onClose={closeDialog} onSelect={applyMission} />
      <ScenesDialog
        open={dialog === 'scenes'}
        recording={recording}
        onClose={closeDialog}
        onPlay={playTour}
        onPlayRecording={() => playTour(recordedTour(recording))}
        onAddView={addView}
        onClearRecording={clearRecording}
      />
      <ShortcutsDialog open={dialog === 'help'} onClose={closeDialog} />
    </div>
  );
}
