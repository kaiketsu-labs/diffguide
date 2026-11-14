/** Claude's question about a sync, above every tab, and the notice offering Undo after Claude merged one. */
import type { OverviewState } from '../../protocol.js';
import { $ } from '../dom.js';
import { setSyncUndo } from '../status.js';

export function renderSync(state: OverviewState): void {
  setSyncUndo(state.syncUndo);
  const question = state.claude.running ? undefined : state.syncQuestion;
  $('sync-ask').hidden = question === undefined;
  const reply = $('sync-reply');
  if (question !== undefined && reply.dataset.html !== question) {
    reply.dataset.html = question;
    reply.innerHTML = question;
  }
}
