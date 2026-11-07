import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ReviewStore, ReviewThread } from './contracts.js';
import { GitHubReviewClient, type GitHubHandoffTarget } from './github.js';
import { createPrExportDraft, maximumPrExportLength, type PrExportDraft } from './prExport.js';
import { webviewStyles } from './webviewStyles.js';

interface PreviewSession {
  readonly draft: PrExportDraft;
  readonly client: GitHubReviewClient;
  target: GitHubHandoffTarget;
  body: string;
  publishedBody: string | undefined;
}

/** Register a human-reviewed handoff without publishing ordinary local comments automatically. */
export function registerPrExport(_context: vscode.ExtensionContext, store: ReviewStore): vscode.Disposable {
  let activePanel: vscode.WebviewPanel | undefined;
  let disposed = false;
  let publicationInFlight: Promise<void> | undefined;
  let retainedPreview: PreviewSession | undefined;

  /** Reuse an existing editable draft instead of discarding the human's changes. */
  function revealExistingPanel(): boolean {
    if (activePanel === undefined) return false;
    activePanel.reveal();
    return true;
  }

  /** Keep edited snapshots available after closing the panel during this editor session. */
  function showPreview(session: PreviewSession): void {
    const { draft, client } = session;
    const panel = vscode.window.createWebviewPanel('diffGuide.prExport', `PR #${session.target.pullRequest.number} · Review übergeben`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    activePanel = panel;
    panel.webview.html = previewHtml(draft, session.target, session.body, session.publishedBody);
    let panelDisposed = false;

    /** Closing the preview must not turn a completed remote write into an unhandled UI error. */
    function post(message: Readonly<Record<string, unknown>>): void {
      if (panelDisposed) return;
      void panel.webview.postMessage(message).then(undefined, () => undefined);
    }

    const listener = panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('action' in value)) return;
      if (value.action === 'openPr') {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(session.target.comment?.url ?? session.target.pullRequest.url));
        } catch (error: unknown) {
          post({ kind: 'error', message: describeError(error) });
        }
        return;
      }
      if (!('body' in value) || typeof value.body !== 'string') return;
      const body = value.body;
      if (value.action === 'draft') {
        session.body = body;
        retainedPreview = body.trim() === (session.publishedBody ?? draft.markdown).trim() ? undefined : session;
        return;
      }
      if (value.action === 'markdown') {
        try {
          const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: body });
          await vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri);
        } catch (error: unknown) {
          post({ kind: 'error', message: describeError(error) });
        }
        return;
      }
      if (value.action !== 'publish' || publicationInFlight !== undefined) return;
      session.body = body;
      retainedPreview = session;
      post({ kind: 'busy' });
      publicationInFlight = (async (): Promise<void> => {
        try {
          const result = await client.publish(session.target, body);
          session.target = result.target;
          session.publishedBody = body.trim();
          if (retainedPreview === session) retainedPreview = undefined;
          post({ kind: 'published', message: result.changed
            ? 'Im GitHub-PR veröffentlicht. Lokaler Review-Status bleibt erhalten.'
            : 'Dieser Stand ist bereits im PR.' });
        } catch (error: unknown) {
          post({ kind: 'error', message: describeError(error) });
        } finally {
          publicationInFlight = undefined;
          post({ kind: 'idle' });
        }
      })();
      await publicationInFlight;
    });
    panel.onDidDispose(() => {
      panelDisposed = true;
      listener.dispose();
      if (activePanel === panel) activePanel = undefined;
    });
  }

  const command = vscode.commands.registerCommand('diffGuide.exportToPr', async () => {
    if (disposed || revealExistingPanel()) return;
    const pendingPublication = publicationInFlight;
    if (pendingPublication !== undefined) {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Vorherige PR-Übergabe wird noch veröffentlicht',
      }, () => pendingPublication);
      if (disposed || revealExistingPanel()) return;
    }
    if (retainedPreview !== undefined) {
      const choice = await vscode.window.showQuickPick([
        { label: 'Entwurf fortsetzen', description: `PR #${retainedPreview.target.pullRequest.number} · eigene Änderungen behalten`, resume: true },
        { label: 'Neue Momentaufnahme', description: 'Aktuelle Unterhaltungen neu auswählen', resume: false },
      ], { title: 'Ungesendete PR-Übergabe', ignoreFocusOut: true });
      if (choice === undefined || disposed || revealExistingPanel()) return;
      if (choice.resume) {
        showPreview(retainedPreview);
        return;
      }
    }
    const sourceThreads = [...store.threads];
    const sourceEvents = [...store.events];
    const capturedAt = new Date().toISOString();
    const candidates = sourceThreads.map((thread) => ({
      thread, draft: createPrExportDraft([thread], sourceEvents, capturedAt),
    }));
    const eligible = candidates.filter(({ draft }) => draft.summaryCount + draft.questionCount > 0);
    if (eligible.length === 0) {
      void vscode.window.showInformationMessage(candidates.some(({ draft }) => draft.pendingSummaryCount > 0)
        ? 'Die angeforderte Zusammenfassung ist noch nicht beantwortet. Warte auf Claudes Antwort oder öffne eine Frage, bevor du sie an den PR übergibst.'
        : 'Es gibt keine Zusammenfassungen oder Fragen in offenen Review-Unterhaltungen zum Übergeben. /r fasst eine bestehende Unterhaltung lokal zusammen.');
      return;
    }
    try {
      const items: (vscode.QuickPickItem & { readonly thread: ReviewThread })[] = eligible.map(({ thread, draft }) => ({
        thread,
        label: `${thread.anchor.path}:${thread.anchor.startLine}${thread.anchor.endLine === thread.anchor.startLine ? '' : `–${thread.anchor.endLine}`}`,
        description: [thread.resolved ? 'Erledigt (optional)' : '', draft.summaryCount ? '/r Zusammenfassung' : '', draft.questionCount ? 'offene Frage' : ''].filter(Boolean).join(' · '),
        detail: thread.messages[0]?.text.replaceAll(/\s+/gu, ' ').slice(0, 140) ?? 'Offene Unterhaltung',
        picked: !thread.resolved,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true, ignoreFocusOut: true, title: 'Welche Unterhaltungen möchtest du an den PR übergeben?',
        placeHolder: 'Offene Unterhaltungen sind ausgewählt. Erledigte Zusammenfassungen kannst du optional ergänzen.',
      });
      if (selected === undefined || selected.length === 0 || disposed || revealExistingPanel()) return;
      const draft = createPrExportDraft(selected.map((item) => item.thread), sourceEvents, capturedAt);
      const client = await GitHubReviewClient.connect(store.workspaceRoot);
      const target = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'GitHub-PR für diesen Branch suchen',
      }, () => client.readTarget());
      if (disposed || revealExistingPanel()) return;
      showPreview({ draft, target, client, body: draft.markdown, publishedBody: undefined });
      retainedPreview = undefined;
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(describeError(error));
    }
  });
  return vscode.Disposable.from(command, { dispose: () => { disposed = true; activePanel?.dispose(); } });
}

/** Present the exact editable outgoing Markdown before any external write is allowed. */
export function previewHtml(draft: PrExportDraft, target: GitHubHandoffTarget, body = draft.markdown, publishedBody?: string): string {
  const nonce = randomUUID().replaceAll('-', '');
  const action = target.comment === undefined ? 'Im PR veröffentlichen' : 'Im PR aktualisieren';
  const summaryLabel = `${draft.summaryCount} ${draft.summaryCount === 1 ? 'Zusammenfassung' : 'Zusammenfassungen'}`;
  const questionLabel = `${draft.questionCount} ${draft.questionCount === 1 ? 'offene Frage' : 'offene Fragen'}`;
  return `<!doctype html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Review an GitHub übergeben</title>
<style nonce="${nonce}">
${webviewStyles}
body{margin:0;padding:28px 30px 20px}main{max-width:1020px;margin:auto}h1{font-size:18px;line-height:26px;font-weight:600;margin:0 0 var(--space-6)}.target{display:flex;align-items:center;gap:var(--space-12);flex-wrap:wrap;margin:var(--space-12) 0 var(--space-16);padding:var(--space-12) var(--space-16);border:1px solid var(--line);border-radius:var(--radius-md)}.target strong{flex:1;min-width:180px;overflow-wrap:anywhere}.target .muted{overflow-wrap:anywhere;min-width:0}.badges{display:flex;gap:var(--space-8);margin:var(--space-12) 0}.badge{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-8);border-radius:var(--radius-pill);font-size:12px;color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 8%,transparent)}label{display:block;font-weight:600;margin:var(--space-16) 0 var(--space-8)}textarea{width:100%;height:45vh;min-height:200px;max-height:none;field-sizing:fixed;padding:var(--space-12);font:12px/19px var(--font-code);tab-size:2}.toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-12);margin:var(--space-8) 0 var(--space-12)}.actions{display:flex;gap:var(--space-8);align-items:center;flex-wrap:wrap}.actions .muted{margin-right:auto}.status{min-height:22px;white-space:pre-wrap;margin:var(--space-12) 0}.error{color:var(--danger)}.success{color:var(--success)}.footnote{font-size:12px;margin:var(--space-8) 0 0}.counter.over{color:var(--danger)}
@media(max-width:480px){body{padding:var(--space-16) var(--space-12)}.target{padding:10px;gap:var(--space-8)}.badges{flex-wrap:wrap}textarea{padding:10px;height:40vh}}
</style></head><body><main>
<h1>Review an GitHub übergeben</h1>
<p class="muted">Entwurf prüfen und veröffentlichen.</p>
<div class="target"><strong>#${target.pullRequest.number} · ${escapeHtml(target.pullRequest.title)}</strong><span class="muted">${escapeHtml(`${target.pullRequest.owner}/${target.pullRequest.repository} · ${target.pullRequest.branch}`)}</span><button id="open">PR öffnen</button></div>
<div class="badges"><span class="badge">${summaryLabel}</span><span class="badge">${questionLabel}</span></div>
<p class="muted">${target.comment === undefined ? 'Neuer PR-Kommentar.' : 'Vorhandenen Kommentar aktualisieren · eigene Ergänzungen bleiben erhalten.'}</p>
<label for="body">Inhalt der Übergabe · Markdown</label>
<textarea id="body" spellcheck="false" aria-describedby="counter">${escapeHtml(body)}</textarea>
<div class="toolbar"><button id="markdown">Markdown-Vorschau</button><span id="counter" class="muted counter"></span></div>
<div class="actions"><span class="muted">${escapeHtml(target.viewerLogin)} · GitHub-Kommentar</span><button id="publish" class="primary">${action}</button></div>
<p id="status" class="status muted" role="status" aria-live="polite">${body === draft.markdown ? '' : 'Ungesendeten Entwurf wiederhergestellt.'}</p>
<p class="muted footnote">Momentaufnahme · Bearbeitete Entwürfe bleiben in dieser VS-Code-Sitzung erhalten.</p>
</main><script nonce="${nonce}">
const api=acquireVsCodeApi();
const body=document.getElementById('body');
const publish=document.getElementById('publish');
const counter=document.getElementById('counter');
const status=document.getElementById('status');
let busy=false;
let composing=false;
let publishedBody=${JSON.stringify(publishedBody ?? null).replaceAll('<', '\\u003c')};
let publishingBody;
function setStatus(tone,text){const className='status '+tone;if(status.className!==className)status.className=className;if(status.textContent!==text)status.textContent=text;}
function update(){const text=body.value.trim();const length=text.length;counter.textContent=length.toLocaleString('de-DE')+' / ${maximumPrExportLength.toLocaleString('de-DE')} Zeichen';counter.classList.toggle('over',length>${maximumPrExportLength});publish.disabled=busy||composing||length===0||length>${maximumPrExportLength}||text===publishedBody;}
body.addEventListener('input',()=>{
  api.postMessage({action:'draft',body:body.value});
  const unchanged=body.value.trim()===publishedBody;
  setStatus(unchanged?'success':'muted',unchanged?'Dieser Stand ist im PR.':'Nicht veröffentlichte Änderungen');
  update();
});
body.addEventListener('compositionstart',()=>{composing=true;update();});
body.addEventListener('compositionend',()=>{composing=false;update();});
publish.addEventListener('click',()=>{
  if(publish.disabled)return;
  busy=true;
  publishingBody=body.value.trim();
  body.readOnly=true;
  setStatus('muted','PR prüfen und veröffentlichen …');
  update();
  api.postMessage({action:'publish',body:body.value});
});
document.getElementById('markdown').addEventListener('click',()=>api.postMessage({action:'markdown',body:body.value}));
document.getElementById('open').addEventListener('click',()=>api.postMessage({action:'openPr'}));
body.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing&&!composing){event.preventDefault();publish.click();}});
window.addEventListener('message',event=>{const message=event.data;if(message.kind==='busy'){busy=true;body.readOnly=true;setStatus('muted','PR prüfen und veröffentlichen …');}else if(message.kind==='idle'){busy=false;body.readOnly=false;}else if(message.kind==='published'){publishedBody=publishingBody??body.value.trim();publish.textContent='Im PR aktualisieren';document.getElementById('open').textContent='Kommentar öffnen';setStatus('success',message.message);}else if(message.kind==='error'){setStatus('error',message.message);}update();});
update();
</script></body></html>`;
}

/** Escape untrusted review content before placing it in a webview document. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Keep a failed preview editable while exposing a useful error to the human. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Die PR-Übergabe konnte nicht vorbereitet werden. Dein lokales Review bleibt gespeichert.';
}
