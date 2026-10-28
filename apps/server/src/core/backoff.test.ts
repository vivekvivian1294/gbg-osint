import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
  const noJitter = () => 0.5;

  it('doubles per failure', () => {
    expect(backoffDelay(1, 1000, 60_000, noJitter)).toBe(1000);
    expect(backoffDelay(2, 1000, 60_000, noJitter)).toBe(2000);
    expect(backoffDelay(4, 1000, 60_000, noJitter)).toBe(8000);
  });

  it('never exceeds the maximum, even with jitter', () => {
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('applies ±20% jitter', () => {
    expect(backoffDelay(1, 1000, 60_000, () => 0)).toBe(800);
    expect(backoffDelay(1, 1000, 60_000, () => 1)).toBe(1200);
  });
});
