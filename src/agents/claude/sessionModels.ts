import type { StreamMessage } from './claudeRunner.js';

/** The model each Claude session DiffGuide started runs on, by session id, so its replies can name it. */
const models = new Map<string, string>();
/** Sessions kept; the oldest goes first. */
const maximumSessions = 200;

/** Remember the model a run's `init` message reports for its session. */
export function readSessionModel(message: StreamMessage): void {
  if (message.type !== 'system' || message['subtype'] !== 'init') return;
  const sessionId = message['session_id'];
  const model = message['model'];
  if (typeof sessionId !== 'string' || typeof model !== 'string' || model === '') return;
  models.delete(sessionId);
  models.set(sessionId, model.slice(0, 100));
  if (models.size > maximumSessions) models.delete(models.keys().next().value!);
}

/** The model of a session DiffGuide started, if it reported one. */
export function sessionModel(sessionId: unknown): string | undefined {
  return typeof sessionId === 'string' ? models.get(sessionId) : undefined;
}
