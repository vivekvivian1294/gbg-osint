import { PostProcessStage, type Scene } from 'cesium';
import type { StyleId } from '../config';

const COMMON = /* glsl */ `
uniform sampler2D colorTexture;
uniform float time;
in vec2 v_textureCoordinates;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float vignette(vec2 uv, float inner, float outer) {
  vec2 c = (uv - 0.5) * vec2(czm_viewport.z / czm_viewport.w, 1.0);
  return smoothstep(outer, inner, length(c));
}
`;

const SHADERS: Record<Exclude<StyleId, 'normal'>, string> = {
  crt: /* glsl */ `${COMMON}
void main() {
  vec2 c = v_textureCoordinates - 0.5;
  vec2 uv = 0.5 + c * (1.0 + 0.06 * dot(c, c));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float shift = 0.0012;
  vec3 col = vec3(
    texture(colorTexture, uv + vec2(shift, 0.0)).r,
    texture(colorTexture, uv).g,
    texture(colorTexture, uv - vec2(shift, 0.0)).b
  );
  float scan = 0.8 + 0.2 * sin(uv.y * czm_viewport.w * 1.6);
  float flicker = 0.97 + 0.03 * sin(time * 50.0);
  col *= scan * flicker * mix(0.55, 1.0, vignette(uv, 0.35, 0.95));
  out_FragColor = vec4(col * vec3(0.95, 1.05, 0.97), 1.0);
}`,

  nvg: /* glsl */ `${COMMON}
void main() {
  vec2 uv = v_textureCoordinates;
  float lum = czm_luminance(texture(colorTexture, uv).rgb);
  lum = clamp(pow(lum, 0.75) * 1.5, 0.0, 1.0);
  float grain = (hash(uv * czm_viewport.zw + fract(time) * 97.0) - 0.5) * 0.16;
  float v = clamp(lum + grain, 0.0, 1.0);
  vec3 phosphor = vec3(0.12, 1.0, 0.3) * v + vec3(0.0, 0.04, 0.0);
  out_FragColor = vec4(phosphor * vignette(uv, 0.3, 0.85), 1.0);
}`,

  flir: /* glsl */ `${COMMON}
void main() {
  vec2 uv = v_textureCoordinates;
  float lum = czm_luminance(texture(colorTexture, uv).rgb);
  float v = pow(smoothstep(0.04, 0.9, lum), 1.15);
  v += (hash(uv * czm_viewport.zw) - 0.5) * 0.03;
  out_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,

  ironbow: /* glsl */ `${COMMON}
vec3 ironbow(float t) {
  t = clamp(t, 0.0, 1.0) * 5.0;
  vec3 c0 = vec3(0.0);
  vec3 c1 = vec3(0.13, 0.0, 0.43);
  vec3 c2 = vec3(0.61, 0.0, 0.62);
  vec3 c3 = vec3(0.92, 0.33, 0.06);
  vec3 c4 = vec3(1.0, 0.8, 0.1);
  vec3 c5 = vec3(1.0, 1.0, 0.92);
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  return mix(c4, c5, t - 4.0);
}
void main() {
  vec2 uv = v_textureCoordinates;
  float lum = czm_luminance(texture(colorTexture, uv).rgb);
  out_FragColor = vec4(ironbow(smoothstep(0.03, 0.92, lum)), 1.0);
}`,

  noir: /* glsl */ `${COMMON}
void main() {
  vec2 uv = v_textureCoordinates;
  float lum = smoothstep(0.08, 0.85, czm_luminance(texture(colorTexture, uv).rgb));
  float grain = (hash(uv * czm_viewport.zw + fract(time) * 53.0) - 0.5) * 0.08;
  float v = clamp(lum + grain, 0.0, 1.0) * mix(0.35, 1.0, vignette(uv, 0.25, 0.9));
  out_FragColor = vec4(vec3(v), 1.0);
}`,
};

const ANIMATED = new Set<StyleId>(['crt', 'nvg', 'noir']);

/** Applies one full-screen GLSL "sensor" look. These are visual effects, not real sensor data. */
export class StyleController {
  private stage: PostProcessStage | undefined;
  private current: StyleId = 'normal';

  constructor(private readonly scene: Scene) {}

  get animated(): boolean {
    return ANIMATED.has(this.current);
  }

  set(id: StyleId): void {
    if (id === this.current) return;
    this.removeStage();
    if (id !== 'normal') {
      const stage = new PostProcessStage({
        fragmentShader: SHADERS[id],
        uniforms: { time: () => (performance.now() / 1000) % 1000 },
      });
      this.scene.postProcessStages.add(stage);
      this.stage = stage;
    }
    this.current = id;
    this.scene.requestRender();
  }

  destroy(): void {
    this.removeStage();
  }

  private removeStage(): void {
    if (this.stage && !this.scene.isDestroyed()) this.scene.postProcessStages.remove(this.stage);
    this.stage = undefined;
  }
}
