export type IconId =
  | 'aircraft'
  | 'satellite'
  | 'bike'
  | 'poi'
  | 'event'
  | 'vehicle'
  | 'ship'
  | 'camera'
  | 'sensor'
  | 'photo';

const SIZE = 32;
const cache = new Map<IconId, HTMLCanvasElement>();

/** White glyphs on a dark outline, so billboard colours can tint them. Drawn pointing north. */
const DRAW: Record<IconId, (ctx: CanvasRenderingContext2D) => void> = {
  aircraft(ctx) {
    ctx.beginPath();
    ctx.moveTo(16, 2);
    ctx.lineTo(19, 12);
    ctx.lineTo(30, 18);
    ctx.lineTo(30, 21);
    ctx.lineTo(19, 18);
    ctx.lineTo(18.5, 25);
    ctx.lineTo(22, 28);
    ctx.lineTo(22, 30);
    ctx.lineTo(16, 28.5);
    ctx.lineTo(10, 30);
    ctx.lineTo(10, 28);
    ctx.lineTo(13.5, 25);
    ctx.lineTo(13, 18);
    ctx.lineTo(2, 21);
    ctx.lineTo(2, 18);
    ctx.lineTo(13, 12);
    ctx.closePath();
  },
  satellite(ctx) {
    ctx.beginPath();
    ctx.rect(12, 12, 8, 8);
    ctx.rect(2, 13, 8, 6);
    ctx.rect(22, 13, 8, 6);
  },
  bike(ctx) {
    ctx.beginPath();
    ctx.arc(16, 16, 9, 0, Math.PI * 2);
    ctx.moveTo(20, 16);
    ctx.arc(16, 16, 4, 0, Math.PI * 2, true);
  },
  poi(ctx) {
    ctx.beginPath();
    ctx.roundRect(7, 7, 18, 18, 4);
    ctx.moveTo(14, 11);
    ctx.lineTo(18, 11);
    ctx.lineTo(18, 14);
    ctx.lineTo(21, 14);
    ctx.lineTo(21, 18);
    ctx.lineTo(18, 18);
    ctx.lineTo(18, 21);
    ctx.lineTo(14, 21);
    ctx.lineTo(14, 18);
    ctx.lineTo(11, 18);
    ctx.lineTo(11, 14);
    ctx.lineTo(14, 14);
    ctx.closePath();
  },
  event(ctx) {
    ctx.beginPath();
    ctx.arc(16, 16, 13, 0, Math.PI * 2);
    ctx.moveTo(25, 16);
    ctx.arc(16, 16, 9, 0, Math.PI * 2, true);
    ctx.moveTo(20, 16);
    ctx.arc(16, 16, 4, 0, Math.PI * 2);
  },
  vehicle(ctx) {
    ctx.beginPath();
    ctx.moveTo(16, 3);
    ctx.lineTo(24, 11);
    ctx.lineTo(24, 28);
    ctx.lineTo(8, 28);
    ctx.lineTo(8, 11);
    ctx.closePath();
  },
  ship(ctx) {
    ctx.beginPath();
    ctx.moveTo(16, 1);
    ctx.quadraticCurveTo(25, 9, 24, 22);
    ctx.lineTo(22, 30);
    ctx.lineTo(10, 30);
    ctx.lineTo(8, 22);
    ctx.quadraticCurveTo(7, 9, 16, 1);
    ctx.closePath();
  },
  camera(ctx) {
    ctx.beginPath();
    ctx.roundRect(9, 16, 14, 12, 2);
    ctx.moveTo(12, 15);
    ctx.lineTo(6, 3);
    ctx.lineTo(26, 3);
    ctx.lineTo(20, 15);
    ctx.closePath();
  },
  sensor(ctx) {
    ctx.beginPath();
    ctx.moveTo(16, 3);
    ctx.lineTo(29, 16);
    ctx.lineTo(16, 29);
    ctx.lineTo(3, 16);
    ctx.closePath();
    ctx.moveTo(20, 16);
    ctx.arc(16, 16, 4, 0, Math.PI * 2);
  },
  /** Where a photo was taken, with a wedge for the direction it looks. */
  photo(ctx) {
    ctx.beginPath();
    ctx.moveTo(16, 17);
    ctx.lineTo(8, 4);
    ctx.quadraticCurveTo(16, 0, 24, 4);
    ctx.closePath();
    ctx.moveTo(21, 22);
    ctx.arc(16, 22, 5, 0, Math.PI * 2);
  },
};

export function getIcon(id: IconId): HTMLCanvasElement {
  const cached = cache.get(id);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    DRAW[id](ctx);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fill('evenodd');
  }
  cache.set(id, canvas);
  return canvas;
}
