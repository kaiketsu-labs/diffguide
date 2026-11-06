import { backoffDelay } from './backoff';

const maxAttempts = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError;
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status == 401 || status == 403 || status == 404) return false;
  return true;
}
