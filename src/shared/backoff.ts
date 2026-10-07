export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 10_000 };

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half random, so
 * reconnecting clients spread out but never retry immediately.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random, opts = DEFAULT_BACKOFF): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return exp / 2 + random() * (exp / 2);
}
