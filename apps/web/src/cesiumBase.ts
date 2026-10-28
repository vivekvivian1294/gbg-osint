declare global {
  interface Window {
    CESIUM_BASE_URL: string;
  }
}

// Must run before Cesium loads workers or assets; see scripts/copy-cesium.mjs.
window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

export {};
