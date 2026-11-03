const firstDelay = 100;
const maxDelay = 5000;

/** Wait time before the next attempt: doubles each time, with up to 20% jitter. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(maxDelay, firstDelay * 2 ** attempt);
  return base + Math.random() * base * 0.2;
}
