const units: readonly [string, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 days ago", "an hour ago", or "just now". */
export function ago(then: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - then.getTime();
  for (const [unit, size] of units) {
    const count = Math.floor(elapsed / size);
    if (count >= 1) return count === 1 ? `a ${unit} ago` : `${count} ${unit}s ago`;
  }
  return 'just now';
}

/** ISO date without the time, in UTC. */
export function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}
