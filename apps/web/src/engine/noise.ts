import {
  Credit,
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  type CesiumWidget,
} from 'cesium';

/** Matches the goteborg.noise connector: the municipality, zoom 10–17. */
const REGION = Rectangle.fromDegrees(11.69, 57.55, 12.25, 57.87);
const MIN_LEVEL = 10;
const MAX_LEVEL = 17;

/** Classes of the city's noise map (LAeq, 24 h), as drawn at half opacity. */
export const NOISE_CLASSES: readonly { label: string; color: string }[] = [
  { label: '< 45 dB', color: '#408080' },
  { label: '45–50 dB', color: '#008080' },
  { label: '50–55 dB', color: '#00ff00' },
  { label: '55–60 dB', color: '#ffff00' },
  { label: '60–65 dB', color: '#ff8040' },
  { label: '≥ 65 dB', color: '#ff0000' },
];

/** Göteborgs Stad's modelled road traffic noise over the basemap. */
export class NoiseLayer {
  private layer: ImageryLayer | null = null;

  constructor(private readonly globe: CesiumWidget) {}

  show(): void {
    if (this.layer) return;
    const provider = new UrlTemplateImageryProvider({
      url: '/api/data/goteborg.noise/laeq/{z}/{x}/{y}.png',
      minimumLevel: MIN_LEVEL,
      maximumLevel: MAX_LEVEL,
      rectangle: REGION,
      credit: new Credit('Road traffic noise 2023: Göteborgs Stad', true),
    });
    this.layer = this.globe.imageryLayers.addImageryProvider(provider);
    this.globe.scene.requestRender();
  }

  hide(): void {
    if (!this.layer) return;
    this.globe.imageryLayers.remove(this.layer, true);
    this.layer = null;
    this.globe.scene.requestRender();
  }
}
