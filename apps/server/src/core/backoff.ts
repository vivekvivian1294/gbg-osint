export function backoffDelay(
  failures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = baseMs * 2 ** Math.max(0, failures - 1);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(maxMs, exponential * jitter));
}
