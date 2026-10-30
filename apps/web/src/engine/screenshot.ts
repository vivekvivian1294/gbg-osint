import type { Scene } from 'cesium';

const FONT_PX = 12;
const PAD_PX = 8;
const LINE = 1.4;
const TIMEOUT_MS = 5_000;

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The globe with the canvases drawn over it, plus a footer with the credits, as a PNG. Copied
 * straight after a render, while WebGL's drawing buffer still holds the frame.
 */
export function captureView(
  scene: Scene,
  overlays: readonly HTMLCanvasElement[],
  credits: string,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      remove();
      resolve(null);
    }, TIMEOUT_MS);
    const remove = scene.postRender.addEventListener(() => {
      remove();
      clearTimeout(timer);
      const source = scene.canvas;
      const { width, height } = source;
      const scale = width / Math.max(1, source.clientWidth);
      const font = `${Math.round(FONT_PX * scale)}px ui-monospace, Menlo, monospace`;
      const pad = Math.round(PAD_PX * scale);
      const out = document.createElement('canvas');
      out.width = width;
      const ctx = out.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.font = font;
      const lines = wrap(ctx, credits, width - 2 * pad);
      const lineHeight = Math.round(FONT_PX * scale * LINE);
      const footer = lines.length * lineHeight + 2 * pad;
      out.height = height + footer;
      ctx.drawImage(source, 0, 0);
      for (const overlay of overlays) ctx.drawImage(overlay, 0, 0, width, height);
      ctx.fillStyle = '#05080c';
      ctx.fillRect(0, height, width, footer);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = font;
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, pad, height + pad + i * lineHeight));
      out.toBlob((blob) => resolve(blob), 'image/png');
    });
    scene.requestRender();
  });
}
