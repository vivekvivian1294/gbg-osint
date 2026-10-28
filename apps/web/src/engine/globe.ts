import { GOTHENBURG, type ClientConfig } from '@gbg-osint/shared';
import {
  Cartesian3,
  CesiumWidget,
  Color,
  DirectionalLight,
  ImageryLayer,
  Math as CesiumMath,
  Matrix4,
  Transforms,
} from 'cesium';
import type { BasemapId } from '../config';
import { BASEMAPS } from './basemaps';
import type { CameraState } from './cameraState';

/** Light from the south-west, 50° up, over Gothenburg: the same shading day and night. */
function cityLight(): DirectionalLight {
  const az = CesiumMath.toRadians(225);
  const el = CesiumMath.toRadians(50);
  const towardsLight = new Cartesian3(
    Math.sin(az) * Math.cos(el),
    Math.cos(az) * Math.cos(el),
    Math.sin(el),
  );
  const enu = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(GOTHENBURG.center.lon, GOTHENBURG.center.lat),
  );
  const direction = Matrix4.multiplyByPointAsVector(enu, towardsLight, new Cartesian3());
  return new DirectionalLight({ direction: Cartesian3.negate(direction, direction) });
}

// CesiumWidget rather than Viewer: Viewer's Knockout-based widgets need CSP 'unsafe-eval'.
export function createGlobe(
  container: HTMLElement,
  creditContainer: HTMLElement,
  basemap: BasemapId,
  keys: ClientConfig,
): CesiumWidget {
  const globe = new CesiumWidget(container, {
    baseLayer: new ImageryLayer(BASEMAPS[basemap].create(keys)),
    creditContainer,
    // Only re-render when something changes; saves battery while the view is idle.
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });
  const { scene } = globe;
  scene.backgroundColor = Color.BLACK;
  scene.globe.baseColor = Color.BLACK;
  scene.light = cityLight();
  scene.screenSpaceCameraController.minimumZoomDistance = 50;
  return globe;
}

/** Replaces only the base layer, so overlays such as radar frames stay on top. */
export function setBasemap(globe: CesiumWidget, basemap: BasemapId, keys: ClientConfig): void {
  const layers = globe.imageryLayers;
  if (layers.length > 0) layers.remove(layers.get(0), true);
  layers.add(new ImageryLayer(BASEMAPS[basemap].create(keys)), 0);
  globe.scene.requestRender();
}

export function getCameraState(globe: CesiumWidget): CameraState {
  const { camera } = globe;
  const pos = camera.positionCartographic;
  return {
    lon: CesiumMath.toDegrees(pos.longitude),
    lat: CesiumMath.toDegrees(pos.latitude),
    height: pos.height,
    heading: CesiumMath.toDegrees(camera.heading),
    pitch: CesiumMath.toDegrees(camera.pitch),
  };
}

export function setCameraState(globe: CesiumWidget, state: CameraState, fly = false): void {
  const destination = Cartesian3.fromDegrees(state.lon, state.lat, state.height);
  const orientation = {
    heading: CesiumMath.toRadians(state.heading),
    pitch: CesiumMath.toRadians(state.pitch),
    roll: 0,
  };
  if (fly) globe.camera.flyTo({ destination, orientation, duration: 2 });
  else globe.camera.setView({ destination, orientation });
}
