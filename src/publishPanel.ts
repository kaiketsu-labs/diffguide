import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { blockBrowserShortcutsScript } from './browserShortcuts.js';
import { escapeCode } from './codePreview.js';
import { webviewStyles } from './webviewStyles.js';

/** A thread's comment as it will be posted, before the user edits it. */
export interface PublishDraft {
  /** Such as "#3 · mock/files.ts:12". */
  readonly title: string;
  /** Where the comment lands, such as "Lines 12–14". */
  readonly placement: string;
  readonly body: string;
  /** Replying inside an existing thread posts right away, so only one button shows. */
  readonly reply?: boolean;
}

const maximumLength = 60_000;

/** Let the user edit a comment and pick pending review or direct; the panel closes once `submit` succeeds. */
export function showPublishPanel(draft: PublishDraft, submit: (body: string, pending: boolean) => Promise<void>): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('diffGuide.publishThread', `Publish · ${draft.title}`, vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = publishHtml(draft);
  let busy = false;
  const listener = panel.webview.onDidReceiveMessage(async (value: unknown) => {
    if (busy || typeof value !== 'object' || value === null) return;
    const { body, pending } = value as { body?: unknown; pending?: unknown };
    if (typeof body !== 'string' || typeof pending !== 'boolean' || body.trim() === '' || body.length > maximumLength) return;
    busy = true;
    try {
      await submit(body.trim(), pending);
      panel.dispose();
    } catch (error: unknown) {
      void panel.webview.postMessage({ error: error instanceof Error ? error.message : String(error) }).then(undefined, () => undefined);
    } finally {
      busy = false;
    }
  });
  panel.onDidDispose(() => { listener.dispose(); });
  return panel;
}

/** Editable comment with the two ways to post it. */
function publishHtml(draft: PublishDraft): string {
  const nonce = randomUUID().replaceAll('-', '');
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Publish to GitHub</title>
<style nonce="${nonce}">
${webviewStyles}
body{margin:0;padding:var(--space-24)}
h1{font-size:18px;line-height:26px;font-weight:600;margin:0 0 var(--space-4);overflow-wrap:anywhere}.muted{margin:0 0 var(--space-16)}
textarea{width:100%;height:45vh;min-height:180px;max-height:none;field-sizing:fixed;padding:var(--space-12);font:12px/19px var(--font-code)}
.actions{display:flex;justify-content:flex-end;gap:var(--space-8);flex-wrap:wrap;margin:var(--space-12) 0}
#status{min-height:20px;white-space:pre-wrap}.error{color:var(--danger)}
</style></head><body>
<h1>${escapeCode(draft.title)}</h1>
<p class="muted">${escapeCode(draft.placement)} · Markdown</p>
<textarea id="body" spellcheck="true" aria-label="Comment">${escapeCode(draft.body)}</textarea>
${draft.reply === true
    ? '<div class="actions"><button id="direct" class="primary">Reply on GitHub</button></div>\n<p id="status" class="muted" role="status" aria-live="polite">Everyone on the PR sees the reply.</p>'
    : '<div class="actions"><button id="direct">Comment now</button><button id="pending" class="primary">Add to pending review</button></div>\n<p id="status" class="muted" role="status" aria-live="polite">A pending comment stays private until you submit your review on GitHub.</p>'}
<script nonce="${nonce}">
${blockBrowserShortcutsScript}
const api=acquireVsCodeApi();
const body=document.getElementById('body');
const pendingButton=document.getElementById('pending');
const directButton=document.getElementById('direct');
const buttons=[pendingButton,directButton].filter(Boolean);
const status=document.getElementById('status');
function update(busy){const length=body.value.trim().length;for(const button of buttons)button.disabled=busy||length===0||length>${maximumLength};}
function send(pending){update(true);status.className='muted';status.textContent='Posting to GitHub…';api.postMessage({body:body.value,pending});}
pendingButton?.addEventListener('click',()=>send(true));
directButton.addEventListener('click',()=>send(false));
body.addEventListener('input',()=>update(false));
window.addEventListener('message',(event)=>{status.className='error';status.textContent=String(event.data.error);update(false);});
update(false);
</script></body></html>`;
}
