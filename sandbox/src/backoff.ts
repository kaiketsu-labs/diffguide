/** Wait time before the next attempt. */
export function backoffDelay(attempt: number): number {
  return 200;
}
