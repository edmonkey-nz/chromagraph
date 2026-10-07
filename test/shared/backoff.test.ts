import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../src/shared/backoff.ts';

describe('backoffDelay', () => {
  it('grows exponentially within jitter bounds', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(4000);
  });

  it('caps at the maximum, even for huge attempt counts', () => {
    expect(backoffDelay(10, () => 1)).toBe(10_000);
    expect(backoffDelay(1e9, () => 1)).toBe(10_000);
    expect(backoffDelay(1e9, () => 0)).toBe(5_000);
  });
});
