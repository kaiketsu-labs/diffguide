import { backoffDelay } from './backoff';

const maxAttempts = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError;
}
