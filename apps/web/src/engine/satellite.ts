import {
  Credit,
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  type CesiumWidget,
} from 'cesium';

/** The server proxies GIBS tiles over Scandinavia only (see the nasa.gibs connector). */
const REGION = Rectangle.fromDegrees(0, 50, 30, 70);
const MAX_LEVEL = 9;
const OPACITY = 0.9;

/** Yesterday's date in UTC: the first day with a complete daily image. */
export function yesterdayUtc(now = Date.now()): string {
  return new Date(now - 24 * 3600_000).toISOString().slice(0, 10);
}

/** Yesterday's true-colour satellite image over the basemap (clouds, snow, ice, algae). */
export class SatelliteLayer {
  private layer: ImageryLayer | null = null;

  constructor(private readonly globe: CesiumWidget) {}

  show(): void {
    if (this.layer) return;
    const date = yesterdayUtc();
    const provider = new UrlTemplateImageryProvider({
      url: `/api/data/nasa.gibs/viirs/${date}/{z}/{x}/{y}.jpg`,
      maximumLevel: MAX_LEVEL,
      rectangle: REGION,
      credit: new Credit(`Satellite ${date}: NASA GIBS, VIIRS NOAA-20`, true),
    });
    // Just above the basemap, so radar frames stay on top.
    this.layer = this.globe.imageryLayers.addImageryProvider(provider, 1);
    this.layer.alpha = OPACITY;
    this.globe.scene.requestRender();
  }

  hide(): void {
    if (!this.layer) return;
    this.globe.imageryLayers.remove(this.layer, true);
    this.layer = null;
    this.globe.scene.requestRender();
  }
}
