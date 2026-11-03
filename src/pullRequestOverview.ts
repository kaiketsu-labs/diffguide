import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { claudeStatus } from './claudeStatus.js';
import type { ReviewIntent, ReviewThread } from './contracts.js';
import type { PullRequestSession } from './pullRequestSessions.js';
import type { MergeMethod, PullRequestDetails, PullRequestSummary, RemoteThread, ReviewEvent } from './pullRequests.js';
import { webviewFontStyles } from './webviewStyles.js';
import { codePreviewStyles } from './codePreview.js';
import { type MarkdownBlock, markdownHtml } from './markdown.js';
import type { FileDiff } from './unifiedDiff.js';
import type { DefinitionPeek } from './definitions.js';
import type { LineRange, ReadRange } from './reviewedFiles.js';

/** Everything the review page shows for one PR, apart from the diff itself. */
export interface OverviewState {
  readonly title: string;
  /** Such as "alice · feature/mock → main". */
  readonly subtitle: string;
  readonly url: string;
  readonly reviewed?: { readonly done: number; readonly total: number };
  /** Paths of files marked reviewed. */
  readonly viewed: readonly string[];
  /** Line ranges marked read, collapsed in the diff. */
  readonly read: readonly ReadRange[];
  readonly claude: { readonly text: string; readonly running: boolean; readonly retry: boolean };
  readonly threads: readonly {
    readonly id: string;
    readonly location: string;
    readonly text: string;
    readonly status: string;
    readonly url?: string;
    readonly path: string;
    /** Which diff side the comment is on: the base ("old") or the PR's version ("new"). */
    readonly side: DiffSide;
    readonly startLine: number;
    readonly endLine: number;
    readonly resolved: boolean;
    /** Rendered from Markdown with escaped text only. */
    readonly messages: readonly { readonly author: 'human' | 'claude'; readonly html: string }[];
  }[];
  /** Diff comment threads on GitHub, by anyone; undefined while loading. */
  readonly github?: readonly GitHubThreadView[];
  readonly githubError?: string;
  /** Code host state; undefined while loading or when the host could not be reached. */
  readonly details?: PullRequestDetails;
  readonly detailsError?: string;
}

export type DiffSide = 'old' | 'new';

export interface GitHubThreadView {
  readonly id: string;
  readonly location: string;
  readonly text: string;
  readonly status: string;
  readonly url: string;
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly outdated: boolean;
  readonly resolved: boolean;
  /** In the viewer's unsubmitted review, so only they see it. */
  readonly pending: boolean;
  /** Bodies as GitHub rendered and sanitized them. */
  readonly messages: readonly { readonly author: string; readonly avatarUrl: string; readonly pending: boolean; readonly html: string }[];
}
export type FilePreview = { readonly kind: 'markdown'; readonly blocks: readonly MarkdownBlock[] } | { readonly kind: 'html'; readonly html: string; readonly marker: string };
type CommentIntent = Extract<ReviewIntent, 'ask' | 'implement'>;

/** A new comment written on lines of the page's diff. */
export interface PageComment {
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly intent: CommentIntent;
}

/** What the page's buttons do. */
export interface OverviewActions {
  comment(comment: PageComment): Promise<void>;
  reply(threadId: string, text: string): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  publish(threadId: string): Promise<void>;
  /** Comment on the PR diff on GitHub, into the pending review or posted right away. */
  commentOnGitHub(comment: Omit<PageComment, 'intent'>, pending: boolean): Promise<void>;
  replyOnGitHub(threadId: string, text: string): Promise<void>;
  resolveOnGitHub(threadId: string, resolved: boolean): Promise<void>;
  readFiles(): Promise<readonly FileDiff[]>;
  /** Every line of a changed file's PR version, highlighted, to expand context. */
  readContext(path: string): Promise<readonly string[]>;
  /** A Markdown file as rendered blocks, or an HTML file's source for a sandboxed frame. */
  readPreview(path: string): Promise<FilePreview>;
  /** Definition of the name at a position in a PR file, or in an earlier definition result. */
  findDefinition(at: { readonly path: string } | { readonly peek: string }, line: number, column: number): Promise<DefinitionPeek | undefined>;
  /** Whether the name at a position has a definition, to underline it while Cmd or Ctrl is held. */
  hasDefinition(at: { readonly path: string } | { readonly peek: string }, line: number, column: number): Promise<boolean>;
  openDefinition(peek: string): Promise<void>;
  setViewed(path: string, viewed: boolean): Promise<void>;
  /** Mark lines read; `fileDone` also marks the whole file reviewed. */
  markRead(range: LineRange, fileDone: boolean): Promise<void>;
  unmarkRead(ids: readonly string[]): Promise<void>;
  openInEditor(path: string): Promise<void>;
  showLog(): void;
  retry(): void;
  revealThread(id: string): Promise<void>;
  submitReview(event: ReviewEvent, body: string): Promise<void>;
  merge(method: MergeMethod): Promise<void>;
  refresh(): void;
}

const reviewEvents: readonly ReviewEvent[] = ['approve', 'requestChanges', 'comment'];
const mergeMethods: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
const commentIntents: readonly unknown[] = ['ask', 'implement'] satisfies CommentIntent[];
const maximumReviewLength = 60_000;
const panels = new Map<string, vscode.WebviewPanel>();

const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= maximumReviewLength;

/** Show a PR's review page, reusing it when already open, and redraw it whenever `onDidChange` fires. */
export async function showPullRequestOverview(
  key: string, read: () => Promise<OverviewState>, onDidChange: vscode.Event<unknown>, actions: OverviewActions, extensionUri: vscode.Uri, revealPath?: string,
): Promise<void> {
  const existing = panels.get(key);
  if (existing !== undefined) {
    existing.reveal();
    if (revealPath !== undefined) void existing.webview.postMessage({ reveal: revealPath }).then(undefined, () => undefined);
    return;
  }
  let reveal = revealPath;
  let state = await read();
  const panel = vscode.window.createWebviewPanel('localReview.pullRequestOverview', state.title, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')], retainContextWhenHidden: true });
  panels.set(key, panel);
  panel.webview.html = overviewHtml(state, panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'claude-mark.svg')).toString());
  const post = (message: unknown): void => { void panel.webview.postMessage(message).then(undefined, () => undefined); };
  const sendFiles = (): void => {
    void actions.readFiles().then((files) => {
      post({ files, reveal });
      reveal = undefined;
    }, (error: unknown) => {
      post({ filesError: error instanceof Error ? error.message : String(error) });
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const redraw = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void read().then((next) => {
        state = next;
        post({ state: next });
      }, () => undefined);
    }, 150);
  };
  let busy = false;
  const subscriptions = [
    onDidChange(redraw),
    panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      const { action, id, ids, event, body, method, path, viewed, side, startLine, endLine, text, intent, resolved, pending, form, peek, line, column } = value as Record<string, unknown>;
      const formKey = typeof form === 'string' && form.length <= 200 ? form : undefined;
      try {
        if (action === 'ready') sendFiles();
        else if (action === 'comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && commentIntents.includes(intent)) {
          await actions.comment({ path, side, startLine, endLine, text: text.trim(), intent: intent as CommentIntent });
          post({ done: formKey });
        } else if (action === 'github-comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && typeof pending === 'boolean') {
          await actions.commentOnGitHub({ path, side, startLine, endLine, text: text.trim() }, pending);
          post({ done: formKey });
        } else if (action === 'reply' && typeof id === 'string' && isText(text)) {
          await actions.reply(id, text.trim());
          post({ done: formKey });
        } else if (action === 'resolve' && typeof id === 'string' && typeof resolved === 'boolean') await actions.resolve(id, resolved);
        else if (action === 'publish' && typeof id === 'string') await actions.publish(id);
        else if (action === 'github-reply' && typeof id === 'string' && isText(text) && state.github?.some((thread) => thread.id === id)) {
          await actions.replyOnGitHub(id, text.trim());
          post({ done: formKey });
        } else if (action === 'github-resolve' && typeof id === 'string' && typeof resolved === 'boolean' && state.github?.some((thread) => thread.id === id)) {
          await actions.resolveOnGitHub(id, resolved);
        }
        else if (action === 'context' && typeof path === 'string') post({ context: { path, lines: await actions.readContext(path) } });
        else if (action === 'preview' && typeof path === 'string') post({ preview: { path, ...await actions.readPreview(path) } });
        else if (action === 'definition' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0) {
          const found = await actions.findDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number);
          post(found === undefined ? { error: 'No definition found here. VS Code needs a language extension for this file type.' } : { definition: found });
        } else if (action === 'probe' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0
          && typeof id === 'string' && id.length <= 400) {
          const found = await actions.hasDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number).catch(() => false);
          post({ probe: { id, found } });
        } else if (action === 'open-definition' && typeof peek === 'string') await actions.openDefinition(peek);
        else if (action === 'log') actions.showLog();
        else if (action === 'retry') actions.retry();
        else if (action === 'refresh') {
          actions.refresh();
          sendFiles();
        } else if (action === 'pr') await vscode.env.openExternal(vscode.Uri.parse(state.url));
        else if (action === 'thread' && typeof id === 'string') await actions.revealThread(id);
        else if (action === 'viewed' && typeof path === 'string' && typeof viewed === 'boolean') await actions.setViewed(path, viewed);
        else if (action === 'read' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && typeof viewed === 'boolean') await actions.markRead({ path, side, startLine, endLine }, viewed);
        else if (action === 'unread' && Array.isArray(ids) && ids.length <= 1000 && ids.every((item) => typeof item === 'string')) await actions.unmarkRead(ids as string[]);
        else if (action === 'editor' && typeof path === 'string') await actions.openInEditor(path);
        else if (action === 'github' && typeof id === 'string') {
          const url = [...state.threads, ...state.github ?? []].find((thread) => thread.id === id)?.url;
          if (url !== undefined) await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if ((action === 'review' || action === 'merge') && !busy) {
          busy = true;
          try {
            if (action === 'review' && reviewEvents.includes(event as ReviewEvent) && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.submitReview(event as ReviewEvent, body.trim());
              post({ done: 'review' });
            } else if (action === 'merge' && mergeMethods.includes(method as MergeMethod)) {
              await actions.merge(method as MergeMethod);
            }
          } finally {
            busy = false;
            post({ idle: true });
          }
        }
      } catch (error: unknown) {
        post({ error: error instanceof Error ? error.message : String(error), form: formKey });
      }
    }),
  ];
  panel.onDidDispose(() => {
    if (timer !== undefined) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    panels.delete(key);
  });
}

/** The review page: PR overview on top, every changed file below. It draws itself from state and file messages. */
export function overviewHtml(state: OverviewState, claudeIcon = ''): string {
  const nonce = randomUUID().replaceAll('-', '');
  // Inline styles are allowed because an HTML preview frame inherits this policy; its sandbox still blocks scripts.
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Review</title>
<style nonce="${nonce}">
${webviewFontStyles}
${codePreviewStyles()}
:root{--border:var(--vscode-panel-border,var(--vscode-widget-border,rgba(128,128,128,.35)));--local:var(--vscode-charts-orange,#d18616);--github:var(--vscode-charts-blue,#3794ff)}
body{margin:0;padding:20px 24px 48px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--review-font-ui);font-size:var(--vscode-font-size);line-height:1.5}
h1{font-size:18px;font-weight:600;margin:0;overflow-wrap:anywhere}
.muted{color:var(--vscode-descriptionForeground)}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.head{justify-content:space-between}
.status{margin-top:10px;font-size:12px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;margin-top:16px;align-items:start}
@media (max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}}
.main-col{display:grid;gap:16px;min-width:0}
.card{padding:10px 14px;border:1px solid var(--border);border-radius:6px}
.rail{border:1px solid var(--border);border-radius:6px}.rail section{padding:10px 14px}.rail section+section{border-top:1px solid var(--border)}
h3{margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden}.seg button{border-radius:0;padding:3px 12px;font-size:12px}.seg button+button{border-left:1px solid var(--border)}
.seg button.on{outline:0;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
.group{display:inline-flex;align-items:center;gap:6px;font-size:12px}
.bar-wrap{flex:1 1 120px;max-width:220px;height:6px;border-radius:3px;background:rgba(128,128,128,.3);overflow:hidden}
.bar-wrap span{display:block;height:100%;background:var(--vscode-progressBar-background,#0078d4)}
button,select{border:1px solid transparent;border-radius:3px;padding:4px 10px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);font:inherit;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}button.on{outline:1px solid var(--vscode-focusBorder)}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,transparent)}
button:focus-visible,a:focus-visible,select:focus-visible,textarea:focus,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
a{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}a:hover{text-decoration:underline}
ul{list-style:none;margin:0;padding:0}li{padding:5px 0}li+li{border-top:1px solid rgba(128,128,128,.2)}
.where{font-family:var(--review-font-code);font-size:12px}.text{overflow-wrap:anywhere}.spin::before{content:'⟳ '}
.ok{color:var(--vscode-testing-iconPassed,#3fb950)}.bad{color:var(--vscode-testing-iconFailed,#f85149)}.wait{color:var(--vscode-testing-iconQueued,#d29922)}
#body{overflow-wrap:anywhere;max-height:320px;overflow:auto}#body img{max-width:100%}#body pre{overflow:auto;padding:8px;background:var(--vscode-textCodeBlock-background)}#body>:first-child{margin-top:0}#body>:last-child{margin-bottom:0}
textarea{box-sizing:border-box;width:100%;min-height:80px;resize:vertical;padding:8px;border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:4px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}
.actions,.spaced{margin-top:8px}
.verdict{display:inline-block;margin:6px 0 0;padding:2px 10px;border-radius:12px;border:1px solid currentColor;font-weight:600}
#error{position:fixed;left:24px;right:24px;bottom:16px;z-index:5;margin:0;padding:8px 12px;border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);border-radius:4px;color:var(--vscode-foreground);background:var(--vscode-inputValidation-errorBackground,#5a1d1d);white-space:pre-wrap;cursor:pointer}#error:empty{display:none}
#files-bar{position:sticky;top:0;z-index:2;margin-top:24px;padding:8px 0;background:var(--vscode-editor-background);border-bottom:1px solid var(--border)}
#files-bar h2{font-size:14px;margin:0}
.file{margin-top:12px;border:1px solid var(--border);border-radius:6px;scroll-margin-top:calc(var(--bar-height,46px) + 10px)}
.file-head{position:sticky;top:var(--bar-height,46px);z-index:1;box-shadow:0 -12px 0 var(--vscode-editor-background);display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--vscode-sideBarSectionHeader-background,var(--vscode-editorWidget-background));border-bottom:1px solid var(--border);border-radius:6px 6px 0 0}
.file.collapsed .file-head{border-bottom:0;border-radius:6px}.file.collapsed .diff{display:none}
.file-head .name{font-family:var(--review-font-code);font-size:12px;overflow-wrap:anywhere;flex:1;cursor:pointer}
.chevron{cursor:pointer;width:14px;user-select:none}.badge{font-weight:700;font-size:11px}
.badge.added{color:var(--vscode-gitDecoration-addedResourceForeground)}.badge.modified{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.badge.deleted{color:var(--vscode-gitDecoration-deletedResourceForeground)}.badge.renamed{color:var(--vscode-gitDecoration-renamedResourceForeground)}
.stat-add{color:var(--vscode-gitDecoration-addedResourceForeground)}.stat-del{color:var(--vscode-gitDecoration-deletedResourceForeground)}
label.viewed{display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px}
.file-head button{padding:2px 8px;font-size:12px}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-family:var(--vscode-editor-font-family,var(--review-font-code));font-size:var(--vscode-editor-font-size,12px);line-height:1.6}
col.num{width:52px}td{vertical-align:top;padding:0}
td.num{text-align:right;padding:0 8px;color:var(--vscode-editorLineNumber-foreground);user-select:none}
td.code{white-space:pre-wrap;word-break:break-all;padding:0 10px 0 18px;text-indent:-10px}
td.code::before{content:'';display:inline-block;width:10px;color:var(--vscode-descriptionForeground)}
tr.add td.code::before{content:'+'}tr.del td.code::before{content:'-'}td.code.add::before{content:'+'}td.code.del::before{content:'-'}
tr.add td,td.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(46,160,67,.18))}
tr.del td,td.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(248,81,73,.18))}
td.empty{background:rgba(128,128,128,.08)}
tr.hunk td{padding:2px 10px;color:var(--vscode-descriptionForeground);background:rgba(128,128,128,.1);font-size:11px}
tr.read-run td{padding:2px 10px;color:var(--vscode-descriptionForeground);background:rgba(128,128,128,.05);font-family:var(--review-font-ui);font-size:11px}
.composer-actions{gap:8px;margin-top:10px}.composer-actions button.quiet:last-child{padding-right:0}div.thread.draft{--soft:color-mix(in srgb,var(--vscode-foreground) 25%,transparent);padding-bottom:12px}
.thread.draft .switch{border-color:color-mix(in srgb,currentColor 25%,transparent)}.thread.draft .switch button.on{color:var(--vscode-editor-background);font-weight:600}.composer-actions .gap{flex:1}
.composer-actions button,.composer-actions select{box-sizing:border-box;height:28px;padding:0 12px}.thread textarea:focus{outline-offset:-1px}
.thread.draft button.primary{color:var(--vscode-editor-background);background:var(--accent);font-weight:600}.thread.draft button.primary:hover{background:color-mix(in srgb,var(--accent) 85%,white)}
.composer-actions button:not(.primary):not(.quiet){border-color:var(--soft)}
button.quiet{background:none;color:var(--vscode-descriptionForeground)}button.quiet:hover{background:none;color:var(--vscode-foreground);text-decoration:underline}
.hint{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--vscode-descriptionForeground)}kbd{display:inline-flex;align-items:center;height:18px;box-sizing:border-box;line-height:1;padding:0 4px;border:1px solid var(--soft,var(--border));border-bottom-width:2px;border-radius:3px;font:11px var(--review-font-code);background:none}
label.check{display:flex;align-items:center;gap:6px;padding-left:12px;border-left:1px solid var(--soft);cursor:pointer;font-size:12px}.strip label.check{padding-left:10px;margin-left:2px}.strip .muted:has(+label.check){margin-left:auto}
tr.read-run .read-label{cursor:pointer;margin-right:10px}tr.read-run button{padding:0 8px;font-size:11px;line-height:1.6}
.expand{display:inline-flex;gap:2px;margin-right:10px}.expand button{padding:0 8px;font-size:11px;line-height:1.6}
td.code.linked{cursor:pointer}::highlight(lr-link){color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground));text-decoration:underline}
::highlight(lr-name){background-color:var(--vscode-editor-wordHighlightStrongBackground,rgba(255,213,0,.3))}
#peek{position:fixed;top:0;right:0;bottom:0;z-index:6;width:min(560px,92vw);display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background,Canvas));box-shadow:-6px 0 16px rgba(0,0,0,.25)}
#peek[hidden]{display:none}.peek-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)}.peek-head .where{flex:1;overflow-wrap:anywhere}
.peek-head button{display:inline-flex;align-items:center;gap:5px;padding:3px 6px}.peek-head button[disabled]{opacity:.4;cursor:default}.peek-head svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#peek-code{flex:1;overflow:auto}tr.focus td{background:var(--vscode-editor-rangeHighlightBackground,rgba(255,213,0,.12))}
.note{padding:10px 14px}
.preview.md{padding:8px 20px 12px;font-family:var(--review-font-ui);line-height:1.6;overflow-wrap:anywhere}
.md-block{margin:0 -10px;padding:1px 10px;border-left:2px solid transparent;border-radius:3px;cursor:pointer}
.md-block:hover{background:rgba(128,128,128,.08);border-left-color:var(--vscode-textLink-foreground)}
.md-block.sel{background:var(--vscode-localReview-selectionBackground,rgba(0,120,215,.18));border-left-color:var(--vscode-localReview-selectionBorder,#0078d4)}
.preview.md>.thread{margin:4px 0 10px}
.md-block h1,.md-block h2{padding-bottom:4px;border-bottom:1px solid var(--border)}.md-block h1{font-size:1.8em}.md-block h2{font-size:1.4em}.md-block h3{font-size:1.15em}
.md-block code{font-family:var(--review-font-code);font-size:.9em;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground) 12%,transparent)}
.md-block pre{padding:10px 12px;border:1px solid var(--border);border-radius:6px;overflow:auto;background:var(--vscode-editor-background,Canvas)}.md-block pre code{padding:0;background:none}
.md-block table{border-collapse:collapse}.md-block th,.md-block td{padding:4px 10px;border:1px solid var(--border)}
.md-block blockquote{margin:8px 0;padding-left:12px;border-left:3px solid var(--border);color:var(--vscode-descriptionForeground)}.md-block img{max-width:100%}
.md-block a{color:var(--vscode-textLink-foreground)}.md-block hr{border:0;border-top:1px solid var(--border)}
.html-preview{display:block;width:100%;border:0;background:#fff}
.html-split{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;padding:0 12px 12px 0}.html-margin{position:relative}.html-margin>.thread{position:absolute;left:0;right:0;margin:0}
@media (max-width:760px){.html-split{grid-template-columns:1fr;padding-right:0}.html-margin>.thread{position:static;margin:8px 12px}}
td.num.pick{cursor:pointer}td.num.pick:hover{color:var(--vscode-textLink-foreground);background:rgba(128,128,128,.18)}
td.drag-sel,td.sel{box-shadow:inset 0 0 0 999px var(--vscode-localReview-selectionBackground,rgba(0,120,215,.18))}
td.sel-start{box-shadow:inset 2px 0 0 var(--vscode-localReview-selectionBorder,#0078d4),inset 0 0 0 999px var(--vscode-localReview-selectionBackground,rgba(0,120,215,.18))}
tr.inline>td{padding:6px 10px 8px}
.thread{--accent:var(--local);max-width:860px;padding:0 12px 8px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;overflow:hidden;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));font-family:var(--review-font-ui);font-size:var(--vscode-font-size);line-height:1.5}
.thread.github{--accent:var(--github)}.thread.pending{border-left-style:dashed}.thread.draft{border:1px dashed var(--accent);border-left:3px dashed var(--accent)}
.thread+.thread{margin-top:6px}
.thread>summary,.thread>.strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 -12px;padding:5px 12px;font-size:12px;background:color-mix(in srgb,var(--accent) 14%,transparent)}
.thread>summary{cursor:pointer;list-style:none}.thread>summary::-webkit-details-marker{display:none}
.thread>summary::before{content:'▸'}.thread[open]>summary::before{content:'▾'}.thread:not([open]){padding-bottom:0}
.strip .tag{font-weight:600;color:var(--accent)}.strip .muted:last-child{margin-left:auto}
.thread textarea{margin-top:8px}
.switch{display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden}.switch button{border-radius:0;padding:1px 10px;font-size:12px}.switch button.on{outline:0;color:var(--vscode-button-foreground);background:var(--accent)}
.msg{margin-top:8px}.msg+.msg{padding-top:8px;border-top:1px solid rgba(128,128,128,.2)}
.who{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}.who img{width:16px;height:16px}.who img.avatar{width:20px;height:20px;border-radius:50%}
.pill{padding:0 7px;border:1px solid var(--vscode-charts-yellow,#d29922);border-radius:10px;font-size:11px;font-weight:500;color:var(--vscode-charts-yellow,#d29922)}
.msg-text{overflow-wrap:anywhere}.msg-text>:first-child{margin-top:2px}.msg-text>:last-child{margin-bottom:0}
.msg-text p,.msg-text ul,.msg-text ol,.msg-text pre,.msg-text blockquote{margin:6px 0}.msg-text ul,.msg-text ol{padding-left:20px}.msg-text ul{list-style:disc}.msg-text li{padding:1px 0;border:0}
.msg-text code{font-family:var(--review-font-code);font-size:.92em;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground) 12%,transparent)}
.msg-text pre{padding:8px 10px;border:1px solid var(--border);border-radius:6px;overflow:auto;background:var(--vscode-editor-background,Canvas)}.msg-text pre code{padding:0;background:none}
.msg-text blockquote{padding-left:10px;border-left:3px solid var(--border);color:var(--vscode-descriptionForeground)}.msg-text img{max-width:100%}
.outside{padding:8px 10px;border-bottom:1px solid var(--border)}.outside>.muted{margin-bottom:6px;font-size:12px}
.comments{font-size:12px}
.card-thread{--accent:var(--local);padding-left:8px;border-left:3px solid var(--accent)}.card-thread.github{--accent:var(--github)}.card-thread .tag{font-size:11px;font-weight:600;color:var(--accent)}
</style></head><body>
<div class="row head"><h1 id="title"></h1><span class="row"><a id="pr">Open on GitHub</a><a id="refresh">Refresh</a></span></div>
<div class="row"><span id="subtitle" class="muted"></span><span id="verdict" class="verdict" hidden></span></div>
<div class="row status"><div class="row" id="reviewed"></div><span id="claude"></span><a id="log">Show log</a><button id="retry">Retry</button></div>
<p id="error" role="alert"></p>
<aside id="peek" hidden aria-label="Definition"><div class="peek-head">
<button id="peek-back" title="Back" aria-label="Back"><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button>
<button id="peek-forward" title="Forward" aria-label="Forward"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button>
<span id="peek-title" class="where"></span>
<button id="peek-open" title="Open in editor"><svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>Open in editor</button>
<button id="peek-close" title="Close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div><div id="peek-code"></div></aside>
<div class="layout">
<div class="main-col">
<section class="card"><h3>Description</h3><div id="body"></div></section>
<section class="card"><h3 id="threads-title">Threads</h3><ul id="threads"></ul></section>
</div>
<aside class="rail">
<section><h3>Reviewers</h3><ul id="reviewers"></ul></section>
<section><h3>Checks</h3><ul id="checks"></ul></section>
<section id="review-box"><h3>Finish your review</h3>
<p class="muted" id="pending-note"></p>
<textarea id="review" placeholder="Leave a summary (optional for approval)" aria-label="Review summary"></textarea>
<div class="row actions"><button class="primary" data-event="approve" data-reviewer>Approve</button><button data-event="requestChanges" data-reviewer>Request changes</button><button data-event="comment">Comment</button></div>
<p class="muted" id="review-note"></p></section>
<section id="merge-box"><h3>Merge</h3><div class="row"><select id="method" aria-label="Merge method"></select><button id="merge">Merge</button></div><p id="mergeable" class="muted"></p></section>
</aside>
</div>
<div id="files-bar" class="row head"><h2 id="files-title">Files</h2><span class="row">
<span class="seg" role="group" aria-label="Diff layout"><button id="unified">Unified</button><button id="split">Split</button></span>
<span class="group"><span class="muted">Files</span><span class="seg"><button id="collapse">Collapse</button><button id="expand">Expand</button></span></span>
<span class="group"><span class="muted">Comments</span><span class="seg"><button id="collapse-comments">Collapse</button><button id="expand-comments">Expand</button></span></span></span></div>
<div id="files"><p class="muted">Loading changes…</p></div>
<script nonce="${nonce}">
const api=acquireVsCodeApi();
const $=(id)=>document.getElementById(id);
const saved=api.getState()||{};
let layout=saved.layout||'unified';
const collapsed=new Map(Object.entries(saved.collapsed||{}));const previewing=new Set(saved.previewing||[]);const previews=new Map();const frameHeight=new Map();const frameTops=new Map();const frameAnchors=new Map();const nonce=document.currentScript.nonce;
/** Runs inside the HTML preview frame: reports clicks as source lines, and where commented elements sit. */
function frameMain(){
  const lines=(node)=>node.dataset.lrLines.split('-').map(Number);
  const target=(event)=>event.target.closest&&event.target.closest('[data-lr-lines]');
  const style=document.createElement('style');
  style.textContent='[data-lr-hover]{outline:2px dashed #0078d4!important;outline-offset:1px;cursor:pointer!important}'+
    '[data-lr-sel]{outline:2px solid #0078d4!important;outline-offset:1px;background-color:rgba(0,120,215,.12)!important}'+
    '[data-lr-anchor=local]{outline:2px solid rgba(209,134,22,.75)!important;outline-offset:1px}[data-lr-anchor=github]{outline:2px solid rgba(55,148,255,.75)!important;outline-offset:1px}'+
    '[data-lr-focus]{outline-width:3px!important;background-color:rgba(128,128,128,.15)!important}';
  document.head.append(style);
  let hover;let anchors=[];let pending=false;
  const closest=(anchor)=>{let exact,inner,size=Infinity,after,afterStart=Infinity;
    for(const node of document.querySelectorAll('[data-lr-lines]')){const [start,end]=lines(node);
      if(!exact&&start===anchor.start&&end===anchor.end)exact=node;
      if(start<=anchor.end&&anchor.end<=end&&end-start<=size){inner=node;size=end-start;}
      if(start>=anchor.end&&start<afterStart){after=node;afterStart=start;}}
    return exact||inner||after;};
  const report=()=>{pending=false;const tops={};
    for(const node of document.querySelectorAll('[data-lr-anchor]'))node.removeAttribute('data-lr-anchor');
    for(const anchor of anchors){const node=closest(anchor);if(!node)continue;anchor.node=node;
      if(anchor.source!=='draft')node.setAttribute('data-lr-anchor',anchor.source);tops[anchor.key]=node.getBoundingClientRect().top+scrollY;}
    parent.postMessage({lrHeight:document.documentElement.scrollHeight,lrAnchors:tops},'*');};
  const schedule=()=>{if(!pending){pending=true;setTimeout(report,30);}};
  new ResizeObserver(schedule).observe(document.documentElement);
  addEventListener('load',schedule);
  addEventListener('mouseover',(event)=>{const at=target(event);if(hover)hover.removeAttribute('data-lr-hover');hover=at;if(at)at.setAttribute('data-lr-hover','');});
  addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();const at=target(event);if(!at)return;
    const [start,end]=lines(at);parent.postMessage({lrPick:{start,end,extend:event.shiftKey,top:at.getBoundingClientRect().top+scrollY}},'*');},true);
  addEventListener('submit',(event)=>event.preventDefault(),true);
  addEventListener('message',(event)=>{if(event.source!==parent)return;const data=event.data||{};
    if(Array.isArray(data.anchors)){anchors=data.anchors;schedule();}
    if('focus' in data){for(const node of document.querySelectorAll('[data-lr-focus]'))node.removeAttribute('data-lr-focus');
      const anchor=anchors.find((item)=>item.key===data.focus);if(anchor&&anchor.node)anchor.node.setAttribute('data-lr-focus','');}
    if(Array.isArray(data.select))for(const node of document.querySelectorAll('[data-lr-lines]')){const [start,end]=lines(node);
      if(start>=data.select[0]&&end<=data.select[1]&&!(node.parentElement&&node.parentElement.closest('[data-lr-sel]')))node.setAttribute('data-lr-sel','');}});
  parent.postMessage({lrReady:true},'*');}
let files;let viewed=new Set();let current;let readRanges=[];const openReads=new Set();const fileKeys=new Map();
const claudeIcon=${JSON.stringify(claudeIcon).replaceAll('<', '\\u003c')};
let composer=saved.composer;
const replies=new Map(Object.entries(saved.replies||{}));
const sending=new Set();const threadOpen=new Map();let focusNext;let sentPending=true;
const contextLines=new Map();const expanded=new Map();const loading=new Set();const step=20;const peeks=[];let peekAt=-1;
const reviewButtons=[...document.querySelectorAll('[data-event]')];
const labels={approved:['✓','ok','Approved'],changes:['✗','bad','Requested changes'],commented:['●','muted','Commented'],dismissed:['○','muted','Dismissed'],requested:['○','wait','Review requested'],
  success:['✓','ok','Passed'],failure:['✗','bad','Failed'],pending:['●','wait','Running'],neutral:['○','muted','Skipped']};
const methodLabels={squash:'Squash and merge',merge:'Create a merge commit',rebase:'Rebase and merge'};
const changeLetters={added:'A',modified:'M',deleted:'D',renamed:'R'};
let busy=false;let author=true;
function save(){api.setState({layout,collapsed:Object.fromEntries(collapsed),previewing:[...previewing],composer,replies:Object.fromEntries(replies)});}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function status(key,name,url){const item=el('li','row');const [icon,tone,label]=labels[key];const mark=el('span',tone,icon);mark.title=label;item.append(mark);
  if(url){const link=el('a','',name);link.href=url;item.append(link);}else item.append(el('span','',name));item.append(el('span','muted',label));return item;}
function setBusy(value){busy=value;for(const button of reviewButtons)button.disabled=value||(author&&button.hasAttribute('data-reviewer'));$('merge').disabled=value||(current&&current.details&&current.details.mergeable==='no');}
const verdictText={changes:['bad','Changes requested by '],approved:['ok','Approved by '],commented:['muted','Commented: ']};
function verdict(reviewers){for(const key of ['changes','approved','commented']){const names=reviewers.filter((reviewer)=>reviewer.state===key).map((reviewer)=>reviewer.name);
  if(names.length)return [verdictText[key][0],verdictText[key][1]+names.join(', ')];}
  const waiting=reviewers.filter((reviewer)=>reviewer.state==='requested').map((reviewer)=>reviewer.name);
  return waiting.length?['wait','Waiting for '+waiting.join(', ')]:['muted','No reviews yet'];}
function allThreads(){return current?[...current.threads.map((thread)=>({...thread,source:'local'})),...(current.github||[]).map((thread)=>({...thread,source:'github'}))]:[];}
function render(state){
  current=state;
  $('title').textContent=state.title;
  $('subtitle').textContent=state.subtitle;
  const details=state.details;
  const body=$('body');
  if(!details){body.replaceChildren(el('span','muted',state.detailsError?'Could not load from GitHub: '+state.detailsError:'Loading from GitHub…'));}
  else if(details.bodyHtml.trim()){body.innerHTML=details.bodyHtml;}
  else body.replaceChildren(el('span','muted','No description.'));
  const reviewers=$('reviewers');reviewers.replaceChildren();
  if(details){for(const reviewer of details.reviewers)reviewers.append(status(reviewer.state,reviewer.name));if(!details.reviewers.length)reviewers.append(el('li','muted','No reviewers yet.'));}
  const checks=$('checks');checks.replaceChildren();
  if(details){for(const check of details.checks)checks.append(status(check.state,check.name,check.url));if(!details.checks.length)checks.append(el('li','muted','No checks.'));}
  const reviewed=$('reviewed');reviewed.replaceChildren();
  if(state.reviewed){const wrap=el('div','bar-wrap');const fill=el('span');fill.style.width=(state.reviewed.total?100*state.reviewed.done/state.reviewed.total:0)+'%';wrap.append(fill);reviewed.append(wrap,el('span','',state.reviewed.done+'/'+state.reviewed.total+' viewed'));}
  const claude=$('claude');claude.textContent=state.claude.text;claude.className=state.claude.running?'spin muted':'muted';
  $('retry').hidden=!state.claude.retry;
  const threads=allThreads();
  $('threads-title').textContent='Threads ('+threads.length+')';
  const list=$('threads');list.replaceChildren();
  if(threads.length===0)list.append(el('li','muted',state.github||state.githubError?'No comments yet.':'No local comments yet. Loading GitHub comments…'));
  if(state.githubError)list.append(el('li','bad','Could not load GitHub comments: '+state.githubError));
  for(const thread of threads){
    const item=el('li','card-thread '+thread.source);const head=el('div','row');const where=el('a','where',thread.location);
    where.addEventListener('click',()=>jump(thread));
    head.append(el('span','tag',thread.source==='github'?'GitHub':'Local'),where,el('span','text',thread.text));
    const line=el('div','muted',thread.status);
    if(thread.url){const link=el('a','',' ↗');link.title='Open on GitHub';link.addEventListener('click',()=>api.postMessage({action:'github',id:thread.id}));line.append(link);}
    item.append(head,line);list.append(item);
  }
  author=!details||details.viewerIsAuthor;setBusy(busy);
  for(const button of document.querySelectorAll('[data-reviewer]'))button.title=author?'GitHub does not let you approve or request changes on your own PR.':'';
  $('review-note').textContent=author?'This is your PR, so you can only comment.':'';
  const pendingCount=details&&details.pendingComments;
  $('pending-note').textContent=details&&details.pendingComments!==undefined?'Your pending review has '+pendingCount+' comment'+(pendingCount===1?'':'s')+'. Only you see '+(pendingCount===1?'it':'them')+' until you submit.':'';
  const badge=$('verdict');badge.hidden=!details;
  if(details){const [tone,label]=verdict(details.reviewers);badge.className='verdict '+tone;badge.textContent=label;}
  $('review-box').hidden=!details||!details.open;
  $('merge-box').hidden=!details||!details.open||!details.mergeMethods.length;
  if(details){
    const select=$('method');const chosen=select.value;select.replaceChildren(...details.mergeMethods.map((method)=>{const option=el('option','',methodLabels[method]);option.value=method;return option;}));
    if(details.mergeMethods.includes(chosen))select.value=chosen;
    $('mergeable').textContent=details.mergeable==='no'?'Has conflicts with the base branch.':details.mergeable==='unknown'?'GitHub is still checking for conflicts.':'';
  }
  const next=new Set(state.viewed);
  for(const path of next)if(!viewed.has(path))collapsed.set(path,true);
  for(const path of viewed)if(!next.has(path))collapsed.set(path,false);
  viewed=next;save();
  readRanges=state.read;
  renderFiles('state');
}
function code(line,side){const cell=el('td','code'+(side?' '+side:''));cell.innerHTML=line.html;if(line.kind!=='del'&&line.newLine!==undefined)cell.dataset.line=String(line.newLine);return cell;}
function num(value,path,side){const cell=el('td','num',value===undefined?'':String(value));
  if(value!==undefined){cell.classList.add('pick');cell.dataset.path=path;cell.dataset.side=side;cell.title='Comment on this line. Drag or Shift-click to select a range.';
    cell.addEventListener('mousedown',(event)=>{if(event.button!==0)return;event.preventDefault();drag={path,side,from:value,to:value,cell};paintDrag();});
    cell.addEventListener('mouseenter',()=>{if(drag&&drag.path===path&&drag.side===side&&drag.to!==value){drag.to=value;paintDrag();}});}
  return cell;}
let drag;
function paintDrag(){for(const cell of document.querySelectorAll('.drag-sel'))cell.classList.remove('drag-sel');if(!drag)return;
  const low=Math.min(drag.from,drag.to),high=Math.max(drag.from,drag.to);
  for(const cell of document.querySelectorAll('td.num.pick')){const line=Number(cell.textContent);
    if(cell.dataset.path!==drag.path||cell.dataset.side!==drag.side||line<low||line>high)continue;
    cell.classList.add('drag-sel');const code=layout==='split'?cell.nextElementSibling:cell.parentElement.lastElementChild;if(code)code.classList.add('drag-sel');}}
document.addEventListener('mouseup',(event)=>{if(!drag)return;const {path,side,from,to}=drag;drag=undefined;paintDrag();
  if(from===to)pick(path,side,from,event.shiftKey);
  else{pick(path,side,Math.min(from,to),false);composer.end=Math.max(from,to);save();renderFiles([path]);}});
function pick(path,side,line,extend){const before=composer&&composer.path;
  if(extend&&composer&&composer.path===path&&composer.side===side){composer.start=Math.min(composer.start,line);composer.end=Math.max(composer.end,line);}
  else composer={path,side,start:line,end:line,text:composer?composer.text:'',intent:composer?composer.intent:'ask',target:composer?composer.target:'claude'};
  focusNext='composer';save();renderFiles([before,path]);}
function range(start,end){return start===end?'Line '+start:'Lines '+start+'–'+end;}
function textarea(key,value,placeholder,onInput,onSubmit,onCancel){const area=el('textarea');area.value=value;area.placeholder=placeholder;area.dataset.draft=key;area.setAttribute('aria-label',placeholder);
  area.addEventListener('input',()=>onInput(area.value));
  area.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();onSubmit();}else if(event.key==='Escape')onCancel();});
  return area;}
function button(label,onClick,className){const node=el('button',className||'',label);node.addEventListener('click',onClick);return node;}
function composerBox(){
  const github=composer.target==='github';
  const box=el('div','thread draft'+(github?' github':''));
  const head=el('div','strip');const toggle=el('span','switch');
  for(const [value,label] of [['claude','Claude'],['github','GitHub']]){const option=button(label,()=>{composer.target=value;focusNext='composer';save();renderFiles([composer.path]);},composer.target===value||(!composer.target&&value==='claude')?'on':'');
    option.setAttribute('aria-pressed',String(option.className==='on'));toggle.append(option);}
  head.append(el('span','tag','New comment'),toggle,el('span','muted',github?'everyone on the PR sees it':'only you and Claude see it'),
    el('span','muted',(composer.side==='old'?'Base · ':'')+range(composer.start,composer.end)));
  box.append(head);
  const cancel=()=>{const path=composer.path;composer=undefined;save();renderFiles([path]);};
  const send=(pending)=>{if(!composer.text.trim()||sending.has('composer'))return;sending.add('composer');sentPending=pending;$('error').textContent='';renderFiles([composer.path]);
    const where={form:'composer',path:composer.path,side:composer.side,startLine:composer.start,endLine:composer.end,text:composer.text};
    api.postMessage(github?{action:'github-comment',pending,...where}:{action:'comment',intent:composer.intent,...where});};
  const submit=()=>send(true);
  const selection={path:composer.path,side:composer.side,startLine:composer.start,endLine:composer.end};
  const file=files&&files.find((item)=>item.path===selection.path);
  const covered=file?selectedReadIds(file,selection):undefined;
  const read=el('label','check');const readBox=el('input');readBox.type='checkbox';readBox.checked=covered!==undefined;
  read.title='Collapse these lines. When every change in the file is read, the file is marked Viewed.';read.append(readBox,'Viewed');
  readBox.addEventListener('change',()=>{
    if(readBox.checked){const done=!!file&&!viewed.has(file.path)&&fullyRead(file,[...readRanges,selection]);
      readRanges=[...readRanges,{id:'pending',...selection}];if(done)markViewed(selection.path,true);
      api.postMessage({action:'read',...selection,viewed:done});}
    else if(covered)unmarkRead(covered);
    if(readBox.checked&&!composer.text.trim())composer=undefined;save();renderFiles([selection.path]);});
  const hint=(label)=>{const node=el('span','hint');node.append(el('kbd','','⌘/Ctrl'),'+',el('kbd','','Enter'),' '+label);return node;};
  const cancelLink=button('Cancel',cancel,'quiet');
  const area=textarea('composer',composer.text,github?'Comment on GitHub':'Ask Claude about these lines',(value)=>{composer.text=value;save();},submit,cancel);
  const busy=sending.has('composer');const row=el('div','row actions composer-actions');
  if(github){
    const review=button(busy&&sentPending?'Sending…':'Add to review',()=>send(true),'primary');review.disabled=busy;review.title='Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing=current&&current.details&&current.details.pendingComments!==undefined;
    const now=button(busy&&!sentPending?'Sending…':'Post now',()=>send(false));now.disabled=busy||reviewing;
    now.title=reviewing?'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.':'Posts on GitHub right away.';
    row.append(review,now,reviewing?el('span','hint','Your review is in progress, so comments go into it.'):hint('adds to review'),el('span','gap'),cancelLink);
  }else{
    const intent=el('select');intent.setAttribute('aria-label','What Claude should do');
    for(const [value,label] of [['ask','Ask a question'],['implement','Ask for a change']]){const option=el('option','',label);option.value=value;intent.append(option);}
    intent.value=composer.intent;intent.addEventListener('change',()=>{composer.intent=intent.value;save();});
    const ask=button(busy?'Sending…':'Ask Claude',submit,'primary');ask.disabled=busy;
    row.append(intent,ask,hint('sends'),el('span','gap'),cancelLink);
  }
  head.append(read);
  box.append(area,row);return box;}
function message(entry,github){const item=el('div','msg');const who=el('div','who');
  if(!github&&entry.author==='claude'&&claudeIcon){const icon=el('img');icon.src=claudeIcon;icon.alt='';who.append(icon);}
  if(github&&entry.avatarUrl){const avatar=el('img','avatar');avatar.src=entry.avatarUrl;avatar.alt='';who.append(avatar);}
  who.append(github?entry.author:entry.author==='claude'?'Claude':'You');
  if(github&&entry.pending)who.append(el('span','pill','Pending'));const body=el('div','msg-text');body.innerHTML=entry.html;item.append(who,body);return item;}
function strip(tag,label,note,right){const node=el(tag,'strip');node.append(el('span','tag',label),el('span','muted',note),el('span','muted',right));return node;}
function threadBox(thread){
  const github=thread.source==='github';
  const box=el('details','thread '+thread.source+(thread.pending?' pending':''));box.id='thread-'+thread.id;
  box.open=threadOpen.has(thread.id)?threadOpen.get(thread.id):!thread.resolved;
  box.addEventListener('toggle',()=>threadOpen.set(thread.id,box.open));
  const status=thread.pending?(thread.outdated?' · Outdated':''):' · '+thread.status;
  box.append(strip('summary',github?'GitHub':'Local',
    github?(thread.pending?'only you see it until you submit your review':'everyone on the PR sees it'):'only you and Claude see it',
    (thread.side==='old'?'Base · ':'')+range(thread.startLine,thread.endLine)+status));
  for(const entry of thread.messages)box.append(message(entry,github));
  const key='reply:'+thread.id;
  const actions=el('div','row actions');
  if(replies.has(thread.id)&&!thread.resolved){
    const cancel=()=>{replies.delete(thread.id);save();renderFiles([thread.path]);};
    const submit=()=>{const text=replies.get(thread.id)||'';if(!text.trim()||sending.has(key))return;sending.add(key);$('error').textContent='';renderFiles([thread.path]);
      api.postMessage({action:github?'github-reply':'reply',form:key,id:thread.id,text});};
    box.append(textarea(key,replies.get(thread.id),github?'Reply on GitHub, visible to everyone':'Reply to Claude',(value)=>{replies.set(thread.id,value);save();},submit,cancel));
    const send=button(sending.has(key)?'Sending…':github?'Post on GitHub':'Reply',submit,'primary');send.disabled=sending.has(key);
    actions.append(send,button('Cancel',cancel));
  }else if(!thread.resolved)actions.append(button('Reply',()=>{replies.set(thread.id,'');focusNext=key;save();renderFiles([thread.path]);}));
  actions.append(button(thread.resolved?'Reopen':'Resolve',()=>api.postMessage({action:github?'github-resolve':'resolve',id:thread.id,resolved:!thread.resolved})));
  actions.append(thread.url?button('Open on GitHub ↗',()=>api.postMessage({action:'github',id:thread.id})):button('Publish to GitHub…',()=>api.postMessage({action:'publish',id:thread.id})));
  box.append(actions);return box;}
function inline(content,width){const row=el('tr','inline');const cell=el('td');cell.colSpan=width;cell.append(content);row.append(cell);return row;}
function jump(thread){
  const known=files&&files.some((file)=>file.path===thread.path);
  if(!known){api.postMessage({action:thread.source==='github'?'github':'thread',id:thread.id});return;}
  if(collapsed.get(thread.path)){collapsed.set(thread.path,false);save();renderFiles([thread.path]);}
  const target=document.getElementById('thread-'+thread.id);if(!target)return;
  target.open=true;threadOpen.set(thread.id,true);target.scrollIntoView({block:'center'});}
function pairs(hunk){const out=[];let dels=[];let adds=[];
  const flush=()=>{for(let i=0;i<Math.max(dels.length,adds.length);i++)out.push([dels[i],adds[i]]);dels=[];adds=[];};
  for(const line of hunk.lines){if(line.kind==='del')dels.push(line);else if(line.kind==='add')adds.push(line);else{flush();out.push([line,line]);}}
  flush();return out;}
function hunkRange(hunk){const match=/^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/.exec(hunk.header);if(!match)return undefined;
  const oldStart=Number(match[1]),oldCount=match[2]===undefined?1:Number(match[2]),newStart=Number(match[3]),newCount=match[4]===undefined?1:Number(match[4]);
  return {oldBefore:oldCount?oldStart-1:oldStart,newBefore:newCount?newStart-1:newStart,oldEnd:oldCount?oldStart+oldCount-1:oldStart,newEnd:newCount?newStart+newCount-1:newStart};}
/** Unchanged lines around each hunk, as new-side line ranges; the last one runs to the end of the file. */
function gapsOf(file){const lines=contextLines.get(file.path);const out=[];let newEnd=0,oldEnd=0;
  for(const hunk of file.hunks){const range=hunkRange(hunk);if(!range)return [];out.push({from:newEnd+1,to:range.newBefore,offset:range.oldBefore-range.newBefore});newEnd=range.newEnd;oldEnd=range.oldEnd;}
  out.push({from:newEnd+1,to:lines?lines.length:Infinity,offset:oldEnd-newEnd,last:true});return out;}
function expansion(path,index){const byFile=expanded.get(path);return byFile&&byFile.get(index)||{top:0,bottom:0};}
function expand(file,index,top,bottom){if(!expanded.has(file.path))expanded.set(file.path,new Map());const current=expansion(file.path,index);
  expanded.get(file.path).set(index,{top:current.top+top,bottom:current.bottom+bottom});loadContext(file);renderFiles([file.path]);}
function previewKind(file){if(file.binary||file.change==='deleted')return undefined;return /\.(md|markdown)$/i.test(file.path)?'markdown':/\.html?$/i.test(file.path)?'html':undefined;}
function loadPreview(file){const key='preview:'+file.path;if(!previews.has(file.path)&&!loading.has(key)){loading.add(key);api.postMessage({action:'preview',path:file.path});}}
function previewNode(file,threads,placed){const data=previews.get(file.path);
  if(!data){loadPreview(file);return el('div','note muted','Loading preview…');}
  if(data.kind==='html'){const wrap=el('div','preview');const frame=el('iframe','html-preview');frame.setAttribute('sandbox','allow-scripts');frame.title='Preview of '+file.path;frame.dataset.path=file.path;
    frame.srcdoc=data.html.replace('<!--'+data.marker+'-->','<script nonce="'+nonce+'">('+frameMain.toString()+')();<'+'/script>');
    frame.style.height=(frameHeight.get(file.path)||600)+'px';
    const margin=el('div','html-margin');margin.dataset.path=file.path;const anchors=[];
    const attach=(card,anchor)=>{card.dataset.anchor=anchor.key;anchors.push(anchor);margin.append(card);
      card.addEventListener('mouseenter',()=>frame.contentWindow&&frame.contentWindow.postMessage({focus:anchor.key},'*'));
      card.addEventListener('mouseleave',()=>frame.contentWindow&&frame.contentWindow.postMessage({focus:null},'*'));};
    for(const thread of threads)if(!placed.has(thread.id)&&!thread.outdated&&thread.side==='new'){placed.add(thread.id);
      attach(threadBox(thread),{key:thread.id,start:thread.startLine,end:thread.endLine,source:thread.source});}
    if(composer&&composer.path===file.path&&composer.side==='new')attach(composerBox(),{key:'composer',start:composer.start,end:composer.end,source:'draft'});
    frameAnchors.set(file.path,anchors);
    const split=el('div','html-split');split.append(frame,margin);
    wrap.append(el('div','note muted','Click an element to comment on its source lines, Shift-click to extend. Scripts in the file are off, and linked stylesheets and relative images do not load.'),split);
    return wrap;}
  const wrap=el('div','preview md');const drafting=composer&&composer.path===file.path&&composer.side==='new';
  for(const block of data.blocks){const node=el('div','md-block');node.innerHTML=block.html;node.title=range(block.startLine,block.endLine)+'. Click to comment, Shift-click to extend.';
    if(drafting&&composer.start<=block.endLine&&composer.end>=block.startLine)node.classList.add('sel');
    node.addEventListener('click',(event)=>{if(event.target.closest('a'))return;
      if(event.shiftKey&&drafting){composer.start=Math.min(composer.start,block.startLine);composer.end=Math.max(composer.end,block.endLine);focusNext='composer';save();renderFiles([file.path]);}
      else{pick(file.path,'new',block.startLine,false);composer.end=block.endLine;save();renderFiles([file.path]);}});
    wrap.append(node);
    for(const thread of threads)if(!placed.has(thread.id)&&!thread.outdated&&thread.side==='new'&&block.startLine<=thread.endLine&&thread.endLine<=block.endLine){placed.add(thread.id);wrap.append(threadBox(thread));}
    if(drafting&&block.startLine<=composer.end&&composer.end<=block.endLine)wrap.append(composerBox());}
  return wrap;}
function frameMessage(frame,data){const path=frame.dataset.path;if(!data||typeof data!=='object')return;
  if(data.lrReady){const drafting=composer&&composer.path===path&&composer.side==='new';
    frame.contentWindow.postMessage({anchors:(frameAnchors.get(path)||[]).map(({key,start,end,source})=>({key,start,end,source})),select:drafting?[composer.start,composer.end]:null},'*');}
  else if(Number.isFinite(data.lrHeight)){const height=Math.min(Math.max(data.lrHeight,100),20000);frameHeight.set(path,height);frame.style.height=height+'px';
    if(data.lrAnchors&&typeof data.lrAnchors==='object'){frameTops.set(path,data.lrAnchors);layoutMargin(frame,data.lrAnchors);}}
  else if(data.lrPick&&Number.isSafeInteger(data.lrPick.start)&&Number.isSafeInteger(data.lrPick.end)&&data.lrPick.start>0&&data.lrPick.start<=data.lrPick.end){
    const {start,end,extend,top}=data.lrPick;const tops={...frameTops.get(path)};
    if(Number.isFinite(top))tops.composer=extend&&Number.isFinite(tops.composer)?Math.min(tops.composer,top):top;frameTops.set(path,tops);
    if(extend&&composer&&composer.path===path&&composer.side==='new'){composer.start=Math.min(composer.start,start);composer.end=Math.max(composer.end,end);focusNext='composer';save();renderFiles([path]);}
    else{pick(path,'new',start,false);composer.end=end;save();renderFiles([path]);}}}
/** Line each margin card up with its element, pushing cards down so they never overlap. */
function layoutMargin(frame,tops){const margin=frame.nextElementSibling;if(!margin||!margin.classList.contains('html-margin'))return;
  const cards=[...margin.children].sort((a,b)=>(Number.isFinite(tops[a.dataset.anchor])?tops[a.dataset.anchor]:Infinity)-(Number.isFinite(tops[b.dataset.anchor])?tops[b.dataset.anchor]:Infinity));
  let next=0;for(const card of cards){const want=tops[card.dataset.anchor];const top=Math.max(Number.isFinite(want)?want:next,next);card.style.top=top+'px';next=top+card.offsetHeight+8;}
  margin.style.minHeight=next+'px';}
function loadContext(file){if(!contextLines.has(file.path)&&!loading.has(file.path)){loading.add(file.path);api.postMessage({action:'context',path:file.path});}}
function fullFile(file){const gaps=gapsOf(file);return contextLines.has(file.path)&&gaps.every((gap,index)=>{const shown=expansion(file.path,index);return shown.top+shown.bottom>=gap.to-gap.from+1;});}
/** Show a file as viewed right away; the extension's next state confirms it. */
function markViewed(path,on){if(on)viewed.add(path);else viewed.delete(path);collapsed.set(path,on);save();}
function unmarkRead(ids){readRanges=readRanges.filter((range)=>!ids.includes(range.id));api.postMessage({action:'unread',ids});}
/** What a file's box shows from extension state, so a state update redraws only the files it changed. */
function fileKey(path,threads){return JSON.stringify([viewed.has(path),collapsed.get(path)===true,readRanges.filter((range)=>range.path===path),threads,
  composer&&composer.path===path?[author,current&&current.details&&current.details.pendingComments]:null]);}
/** Diff lines inside read ranges, with the ids of the ranges covering each; marking added lines also covers the lines they replace, and the reverse. */
function readLines(file,ranges){const lines=file.hunks.flatMap((hunk)=>hunk.lines);const read=new Map();
  for(const range of ranges){if(range.path!==file.path)continue;const key=range.side==='old'?'oldLine':'newLine';let first=-1,last=-1;
    lines.forEach((line,index)=>{const number=line[key];if(number!==undefined&&number>=range.startLine&&number<=range.endLine){if(first<0)first=index;last=index;}});
    if(first<0)continue;
    if(range.side==='new'&&lines[first].kind==='add')while(first>0&&lines[first-1].kind==='del')first--;
    if(range.side==='old'&&lines[last].kind==='del')while(last<lines.length-1&&lines[last+1].kind==='add')last++;
    for(let index=first;index<=last;index++){const line=lines[index];if(!read.has(line))read.set(line,[]);if(range.id)read.get(line).push(range.id);}}
  return read;}
/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
function selectedReadIds(file,range){const read=readLines(file,readRanges);const key=range.side==='old'?'oldLine':'newLine';
  const lines=file.hunks.flatMap((hunk)=>hunk.lines).filter((line)=>line[key]!==undefined&&line[key]>=range.startLine&&line[key]<=range.endLine);
  return lines.length&&lines.every((line)=>read.has(line))?[...new Set(lines.flatMap((line)=>read.get(line)))]:undefined;}
function fullyRead(file,ranges){const read=readLines(file,ranges);return file.hunks.every((hunk)=>hunk.lines.every((line)=>line.kind==='context'||read.has(line)));}
function table(file,threads,placed){
  const node=el('table');const columns=el('colgroup');
  const widths=layout==='split'?['num','','num','']:['num','num',''];
  for(const name of widths){const column=el('col',name);columns.append(column);}node.append(columns);
  const add=(row,covers,hidden)=>{if(!hidden)node.append(row);
    for(const [side,line] of covers){if(line===undefined)continue;
      if(composer&&composer.path===file.path&&composer.side===side&&composer.start<=line&&line<=composer.end){
        const cells=[...row.children].slice(layout==='split'&&side==='new'?2:0,layout==='split'&&side==='old'?2:undefined);
        for(const cell of cells)cell.classList.add('sel');cells[0].classList.add('sel-start');}
      for(const thread of threads)if(!placed.has(thread.id)&&!thread.outdated&&thread.side===side&&thread.endLine===line){placed.add(thread.id);node.append(inline(threadBox(thread),widths.length));}
      if(composer&&composer.path===file.path&&composer.side===side&&composer.end===line)node.append(inline(composerBox(),widths.length));}};
  const lineRow=(line,hidden)=>{const row=el('tr',line.kind);row.append(num(line.oldLine,file.path,'old'),num(line.newLine,file.path,'new'),code(line,''));add(row,[['old',line.oldLine],['new',line.newLine]],hidden);};
  const pairRow=(left,right,hidden)=>{const row=el('tr');const same=left===right;
    if(left){row.append(num(left.oldLine,file.path,'old'),code(left,same?'':'del'));}else row.append(el('td','num empty'),el('td','code empty'));
    if(right){row.append(num(right.newLine,file.path,'new'),code(right,same?'':'add'));}else row.append(el('td','num empty'),el('td','code empty'));
    add(row,[['old',left&&left.oldLine],['new',right&&right.newLine]],hidden);};
  const contextRow=(newLine,offset)=>{const html=(contextLines.get(file.path)||[])[newLine-1];if(html===undefined)return;
    const line={kind:'context',oldLine:newLine+offset,newLine,html};if(layout==='split')pairRow(line,line);else lineRow(line);};
  const gaps=gapsOf(file);
  const read=readLines(file,readRanges);
  const readRow=(lines,key,open)=>{const row=el('tr','read-run');const cell=el('td');cell.colSpan=widths.length;row.append(cell);
    const label=el('span','read-label',(open?'▾ ':'▸ ')+'✓ '+lines.length+(lines.length===1?' line read':' lines read'));label.title=open?'Hide these lines':'Show these lines';
    label.addEventListener('click',()=>{if(open)openReads.delete(key);else openReads.add(key);renderFiles([file.path]);});
    const ids=[...new Set(lines.flatMap((line)=>read.get(line)))];
    cell.append(label,button('Unmark',()=>{unmarkRead(ids);renderFiles([file.path]);}));return row;};
  const expander=(gap,index,header)=>{const size=gap.to-gap.from+1;const shown=expansion(file.path,index);const hidden=size-shown.top-shown.bottom;
    const row=el('tr','hunk');const cell=el('td');cell.colSpan=widths.length;row.append(cell);
    if(hidden>0){const tools=el('span','expand');
      if(hidden<=step&&!gap.last)tools.append(button('↕',()=>expand(file,index,hidden,0)));
      else{if(index>0)tools.append(button('↓',()=>expand(file,index,step,0)));if(!gap.last)tools.append(button('↑',()=>expand(file,index,0,step)));}
      for(const tool of tools.children)tool.title=tool.textContent==='↕'?'Show '+hidden+' hidden lines':tool.textContent==='↓'?'Show '+step+' more lines below':'Show '+step+' more lines above';
      cell.append(tools);}
    if(header)cell.append(el('span','',header));
    else if(hidden>0)cell.append(el('span','',Number.isFinite(hidden)?hidden+' more lines':'Rest of the file'));
    if(hidden>0||(header&&size<=0))node.append(row);};
  const gapRows=(gap,index,header)=>{const size=gap.to-gap.from+1;const shown=expansion(file.path,index);
    if(size<=0){if(header)expander({from:1,to:0},index,header);return;}
    if(!contextLines.has(file.path)){expander(gap,index,header);return;}
    const top=Math.min(shown.top,size),bottom=Math.min(shown.bottom,size-top);
    for(let line=gap.from;line<gap.from+top;line++)contextRow(line,gap.offset);
    expander(gap,index,header);
    for(let line=gap.to-bottom+1;line<=gap.to;line++)contextRow(line,gap.offset);};
  file.hunks.forEach((hunk,index)=>{
    if(gaps[index])gapRows(gaps[index],index,hunk.header);
    else{const header=el('tr','hunk');const cell=el('td','',hunk.header);cell.colSpan=widths.length;header.append(cell);node.append(header);}
    const rows=layout==='split'?pairs(hunk):hunk.lines.map((line)=>[line]);
    const draw=(row,hidden)=>layout==='split'?pairRow(row[0],row[1],hidden):lineRow(row[0],hidden);
    const isRead=(row)=>row.every((line)=>!line||read.has(line));
    for(let at=0;at<rows.length;){
      if(!isRead(rows[at])){draw(rows[at],false);at+=1;continue;}
      let end=at;while(end<rows.length&&isRead(rows[end]))end+=1;
      const run=rows.slice(at,end);const lines=[...new Set(run.flat().filter(Boolean))];
      const key=file.path+':'+(lines[0].oldLine??'')+':'+(lines[0].newLine??'');const open=openReads.has(key);
      node.append(readRow(lines,key,open));
      for(const row of run)draw(row,!open);
      at=end;}
  });
  const last=gaps[file.hunks.length];if(last&&file.change!=='added'&&file.change!=='deleted')gapRows(last,file.hunks.length);
  return node;
}
/** Redraw the file list; given paths, or 'state' for files whose state changed, redraw only those boxes when the rest are on the page. */
function renderFiles(only){
  $('unified').className=layout==='unified'?'on':'';$('split').className=layout==='split'?'on':'';
  if(!files)return;
  const container=$('files');
  const scroll=window.scrollY;
  const active=document.activeElement;
  const focus=active&&active.dataset&&active.dataset.draft?{key:active.dataset.draft,start:active.selectionStart,end:active.selectionEnd}:undefined;
  const threadsByFile=new Map();
  for(const thread of allThreads()){if(!threadsByFile.has(thread.path))threadsByFile.set(thread.path,[]);threadsByFile.get(thread.path).push(thread);}
  $('files-title').textContent='Files ('+files.length+') · '+files.filter((file)=>viewed.has(file.path)).length+' viewed';
  const boxes=new Map([...container.children].filter((node)=>node.classList.contains('file')).map((node)=>[node.dataset.path,node]));
  const threadsOf=(path)=>threadsByFile.get(path)||[];
  const changed=only==='state'?files.map((file)=>file.path).filter((path)=>fileKeys.get(path)!==fileKey(path,threadsOf(path))):only;
  const targets=changed&&boxes.size===files.length?[...new Set(changed.filter(Boolean))]:undefined;
  const draw=(file)=>{fileKeys.set(file.path,fileKey(file.path,threadsOf(file.path)));return fileBox(file,threadsOf(file.path));};
  if(targets&&targets.every((path)=>boxes.has(path))){
    for(const path of targets)boxes.get(path).replaceWith(draw(files.find((file)=>file.path===path)));
  }else{
    container.replaceChildren();fileKeys.clear();
    if(!files.length)container.append(el('p','muted','No changes against the base branch.'));
    for(const file of files)container.append(draw(file));
  }
  for(const frame of container.querySelectorAll('iframe.html-preview'))layoutMargin(frame,frameTops.get(frame.dataset.path)||{});
  if(focus){const area=container.querySelector('[data-draft="'+CSS.escape(focus.key)+'"]');if(area){area.focus({preventScroll:true});area.setSelectionRange(focus.start,focus.end);}}
  window.scrollTo(0,scroll);
  if(focusNext){const area=container.querySelector('[data-draft="'+CSS.escape(focusNext)+'"]');focusNext=undefined;if(area)area.focus();}
}
function fileBox(file,threads){
    const isCollapsed=collapsed.get(file.path)===true;
    const box=el('div','file'+(isCollapsed?' collapsed':''));box.dataset.path=file.path;
    const head=el('div','file-head');
    const chevron=el('span','chevron',isCollapsed?'▸':'▾');
    const name=el('span','name',file.oldPath?file.oldPath+' → '+file.path:file.path);
    const toggle=()=>{collapsed.set(file.path,!isCollapsed);save();renderFiles([file.path]);};
    chevron.addEventListener('click',toggle);name.addEventListener('click',toggle);
    const badge=el('span','badge '+file.change,changeLetters[file.change]);badge.title=file.change;
    const stats=el('span','');stats.append(el('span','stat-add','+'+file.additions),' ',el('span','stat-del','−'+file.deletions));
    const label=el('label','viewed');const box2=el('input');box2.type='checkbox';box2.checked=viewed.has(file.path);
    box2.addEventListener('change',()=>{markViewed(file.path,box2.checked);api.postMessage({action:'viewed',path:file.path,viewed:box2.checked});renderFiles([file.path]);});
    label.append(box2,'Viewed');
    const open=el('button','','Open in editor');open.addEventListener('click',()=>api.postMessage({action:'editor',path:file.path}));
    const whole=fullFile(file);const full=button(whole?'Diff only':'Full file',()=>{
      expanded.set(file.path,whole?new Map():new Map(file.hunks.concat([null]).map((_,index)=>[index,{top:Infinity,bottom:0}])));loadContext(file);renderFiles([file.path]);});
    const kind=previewKind(file);const showPreview=kind!==undefined&&previewing.has(file.path);
    full.hidden=showPreview||file.binary||file.change==='added'||file.change==='deleted'||!file.hunks.length;
    const mode=el('span','seg');mode.hidden=kind===undefined;
    for(const [label,on] of [['Diff',false],['Preview',true]]){const option=button(label,()=>{if(on)previewing.add(file.path);else previewing.delete(file.path);save();renderFiles([file.path]);});option.className=showPreview===on?'on':'';mode.append(option);}
    const unresolved=threads.filter((thread)=>!thread.resolved).length;
    const comments=el('span','muted comments',!threads.length?'':threads.length+(threads.length===1?' comment':' comments')+(unresolved===threads.length?'':', '+unresolved+' open'));
    head.append(chevron,name,badge,stats,comments,mode,label,full,open);box.append(head);
    const diff=el('div','diff');const placed=new Set();
    if(file.binary)diff.append(el('div','note muted','Binary file not shown.'));
    else if(showPreview)diff.append(previewNode(file,threads,placed));
    else if(!file.hunks.length)diff.append(el('div','note muted',file.change==='renamed'?'Renamed without changes.':'No content changes.'));
    else diff.append(table(file,threads,placed));
    const outside=threads.filter((thread)=>!placed.has(thread.id));
    if(outside.length){const block=el('div','outside');block.append(el('div','muted','Comments on lines this diff does not show'),...outside.map(threadBox));diff.prepend(block);}
    box.append(diff);return box;
}
for(const [id,action] of [['pr','pr'],['log','log'],['retry','retry'],['refresh','refresh']])$(id).addEventListener('click',()=>api.postMessage({action}));
$('error').addEventListener('click',()=>{$('error').textContent='';});
function columnAt(cell,event){const range=document.caretRangeFromPoint(event.clientX,event.clientY);if(!range||!cell.contains(range.startContainer))return undefined;
  const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let offset=0;let node;
  while((node=walker.nextNode())){if(node===range.startContainer)return offset+range.startOffset;offset+=node.textContent.length;}return undefined;}
function textRange(cell,start,end){const range=document.createRange();const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let offset=0;let node;let begun=false;
  while((node=walker.nextNode())){const length=node.textContent.length;
    if(!begun&&start<=offset+length){range.setStart(node,start-offset);begun=true;}
    if(begun&&end<=offset+length){range.setEnd(node,end-offset);return range;}offset+=length;}return undefined;}
function wordAt(cell,column){const text=cell.textContent;const word=/[\\p{L}\\p{N}_$]/u;if(column>=text.length||!word.test(text[column]))return undefined;
  let start=column;let end=column;while(start>0&&word.test(text[start-1]))start-=1;while(end<text.length&&word.test(text[end]))end+=1;return {start,end};}
function lookupTarget(cell){const peekId=cell.closest('#peek')?peeks[peekAt]&&peeks[peekAt].id:undefined;const fileBox=cell.closest('.file');
  return peekId?{peek:peekId}:fileBox?{path:fileBox.dataset.path}:undefined;}
const probes=new Map();let hovered;let pointer;let probeTimer;
function setHighlight(name,range){if(!window.CSS||!CSS.highlights)return;if(range)CSS.highlights.set(name,new Highlight(range));else CSS.highlights.delete(name);}
function showLink(){document.querySelectorAll('td.code.linked').forEach((cell)=>cell.classList.remove('linked'));
  if(!hovered||probes.get(hovered.id)!==true){setHighlight('lr-link');return;}
  hovered.cell.classList.add('linked');setHighlight('lr-link',textRange(hovered.cell,hovered.start,hovered.end));}
function probeAt(event){clearTimeout(probeTimer);hovered=undefined;
  const cell=event.target&&event.target.closest&&event.target.closest('td.code[data-line]');const target=cell&&lookupTarget(cell);
  const column=cell?columnAt(cell,event):undefined;const word=column===undefined?undefined:wordAt(cell,column);
  if(!target||!word){showLink();return;}
  const id=JSON.stringify([target.peek||target.path,cell.dataset.line,word.start]);hovered={id,cell,start:word.start,end:word.end};showLink();
  if(probes.has(id))return;
  probeTimer=setTimeout(()=>{probes.set(id,'pending');api.postMessage({action:'probe',id,...target,line:Number(cell.dataset.line),column:word.start});},60);}
document.addEventListener('mousemove',(event)=>{pointer=event;if(event.metaKey||event.ctrlKey)probeAt(event);else if(hovered){hovered=undefined;showLink();}});
document.addEventListener('click',(event)=>{if(!(event.metaKey||event.ctrlKey))return;const cell=event.target.closest&&event.target.closest('td.code[data-line]');if(!cell)return;
  const column=columnAt(cell,event);const target=lookupTarget(cell);if(column===undefined||!target)return;event.preventDefault();$('error').textContent='';
  api.postMessage({action:'definition',...target,line:Number(cell.dataset.line),column});});
for(const type of ['keydown','keyup'])window.addEventListener(type,(event)=>{const held=event.metaKey||event.ctrlKey;document.body.classList.toggle('peeking',held);
  if(held&&pointer)probeAt(pointer);else if(!held){clearTimeout(probeTimer);hovered=undefined;showLink();}});
window.addEventListener('blur',()=>{hovered=undefined;showLink();});
function closePeek(){peeks.length=0;peekAt=-1;renderPeek();}
window.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&peeks.length&&!(event.target instanceof HTMLTextAreaElement))closePeek();});
function renderPeek(){const panel=$('peek');panel.hidden=peekAt<0;setHighlight('lr-name');if(peekAt<0)return;const peek=peeks[peekAt];
  $('peek-title').textContent=peek.location;$('peek-back').disabled=peekAt<1;$('peek-forward').disabled=peekAt>=peeks.length-1;
  const body=el('table');const columns=el('colgroup');columns.append(el('col','num'),el('col'));body.append(columns);let nameCell;
  peek.lines.forEach((html,index)=>{const line=peek.startLine+index;const row=el('tr',line>=peek.focus.start&&line<=peek.focus.end?'focus':'');
    const cell=el('td','code');cell.innerHTML=html;cell.dataset.line=String(line);row.append(el('td','num',String(line)),cell);body.append(row);
    if(peek.name&&peek.name.line===line)nameCell=cell;});
  const code=$('peek-code');code.replaceChildren(body);
  if(nameCell)setHighlight('lr-name',textRange(nameCell,peek.name.start,peek.name.end));
  const first=body.querySelector('tr.focus');if(first)code.scrollTop=Math.max(0,first.getBoundingClientRect().top-code.getBoundingClientRect().top-3*first.offsetHeight);}
$('peek-close').addEventListener('click',closePeek);
$('peek-back').addEventListener('click',()=>{if(peekAt>0){peekAt-=1;renderPeek();}});
$('peek-forward').addEventListener('click',()=>{if(peekAt<peeks.length-1){peekAt+=1;renderPeek();}});
$('peek-open').addEventListener('click',()=>{const peek=peeks[peekAt];if(peek)api.postMessage({action:'open-definition',peek:peek.id});});
$('unified').addEventListener('click',()=>{layout='unified';save();renderFiles();});
$('split').addEventListener('click',()=>{layout='split';save();renderFiles();});
$('collapse').addEventListener('click',()=>{for(const file of files||[])collapsed.set(file.path,true);save();renderFiles();});
$('expand').addEventListener('click',()=>{for(const file of files||[])collapsed.set(file.path,false);save();renderFiles();});
for(const [id,open] of [['collapse-comments',false],['expand-comments',true]])$(id).addEventListener('click',()=>{for(const thread of allThreads())threadOpen.set(thread.id,open);renderFiles();});
for(const button of reviewButtons)button.addEventListener('click',()=>{$('error').textContent='';setBusy(true);api.postMessage({action:'review',event:button.dataset.event,body:$('review').value});});
$('merge').addEventListener('click',()=>{$('error').textContent='';setBusy(true);api.postMessage({action:'merge',method:$('method').value});});
window.addEventListener('message',(event)=>{const data=event.data;
  const frame=event.source&&[...document.querySelectorAll('iframe.html-preview')].find((node)=>node.contentWindow===event.source);
  if(frame){frameMessage(frame,data);return;}
  if(data.state)render(data.state);
  if(data.files){files=data.files;contextLines.clear();loading.clear();renderFiles();}
  if(data.preview){previews.set(data.preview.path,data.preview);loading.delete('preview:'+data.preview.path);renderFiles([data.preview.path]);}
  if(data.context){contextLines.set(data.context.path,data.context.lines);loading.delete(data.context.path);renderFiles([data.context.path]);}
  if(data.definition){peeks.length=peekAt+1;peeks.push(data.definition);peekAt=peeks.length-1;renderPeek();}
  if(data.probe){probes.set(data.probe.id,data.probe.found);showLink();}
  if(data.reveal&&files){collapsed.set(data.reveal,false);save();renderFiles();const target=document.querySelector('[data-path="'+CSS.escape(data.reveal)+'"]');if(target)target.scrollIntoView({block:'start'});}
  if(data.filesError)$('files').replaceChildren(el('p','bad','Could not read the changes: '+data.filesError));
  if(data.error){loading.clear();$('error').textContent=String(data.error);if(data.form&&sending.delete(data.form))renderFiles();}
  if(data.done==='review')$('review').value='';
  if(data.done==='composer'){sending.delete('composer');const path=composer&&composer.path;composer=undefined;save();renderFiles([path]);}
  if(typeof data.done==='string'&&data.done.startsWith('reply:')){sending.delete(data.done);replies.delete(data.done.slice(6));save();renderFiles();}
  if(data.idle)setBusy(false);});
render(${JSON.stringify(state).replaceAll('<', '\\u003c')});
new ResizeObserver(([entry])=>document.body.style.setProperty('--bar-height',entry.target.offsetHeight+'px')).observe($('files-bar'));
api.postMessage({action:'ready'});
</script></body></html>`;
}

function githubThreadView(thread: RemoteThread): GitHubThreadView {
  return {
    id: thread.id,
    location: `${thread.path}:${thread.startLine}`,
    text: plainText(thread.comments[0]?.bodyHtml ?? '').slice(0, 140),
    status: [thread.pending ? 'Pending' : thread.resolved ? 'Resolved' : 'Open', thread.outdated ? 'Outdated' : undefined].filter(Boolean).join(' · '),
    url: thread.url,
    path: thread.path,
    side: thread.side === 'LEFT' ? 'old' : 'new',
    startLine: thread.startLine,
    endLine: thread.endLine,
    outdated: thread.outdated,
    resolved: thread.resolved,
    pending: thread.pending,
    messages: thread.comments.map(({ author, avatarUrl, pending, bodyHtml }) => ({ author, avatarUrl, pending, html: bodyHtml })),
  };
}

const htmlEntities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** One-line text of GitHub's rendered HTML, for the thread list. */
function plainText(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, ' ').replaceAll(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => htmlEntities[entity] ?? entity).replaceAll(/\s+/gu, ' ').trim();
}

const threadStatus: Record<ReviewThread['status'], string> = {
  queued: 'Waiting for Claude', received: 'Picked up', working: 'Claude is working', answered: 'Answered', ready: 'Ready for review',
};

/** Collect a PR's overview from its summary, file progress and review session. */
export function buildOverviewState(
  pullRequest: PullRequestSummary, opened: PullRequestSession, viewed: readonly string[], read: readonly ReadRange[], total: number | undefined,
  details?: PullRequestDetails | Error, remote?: readonly RemoteThread[] | Error,
): OverviewState {
  const { session, runner } = opened;
  const claude = claudeStatus(runner.activity);
  return {
    title: `#${pullRequest.number} ${pullRequest.title}`,
    subtitle: `${pullRequest.author} · ${pullRequest.headBranch} → ${pullRequest.baseBranch}`,
    url: pullRequest.url,
    viewed,
    read,
    ...(total === undefined ? {} : { reviewed: { done: viewed.length, total } }),
    ...(details === undefined ? {} : details instanceof Error ? { detailsError: details.message } : { details }),
    ...(remote === undefined ? {} : remote instanceof Error ? { githubError: remote.message } : { github: remote.map(githubThreadView) }),
    claude: { text: claude.text, running: runner.activity.running, retry: claude.retry },
    threads: session.store.threads.map((thread) => {
      const publication = session.publication?.(thread.id);
      const status = [
        thread.resolved ? 'Resolved' : session.activity?.(thread.id) ?? threadStatus[thread.status],
        publication === undefined ? undefined : publication.pending ? 'On GitHub (pending)' : 'On GitHub',
      ].filter(Boolean).join(' · ');
      return {
        id: thread.id,
        location: `${thread.anchor.path}:${thread.anchor.startLine}`,
        text: thread.messages[0]?.text.replaceAll(/\s+/gu, ' ').slice(0, 140) ?? '',
        status,
        path: thread.anchor.path,
        side: thread.anchor.side === 'original' ? 'old' : 'new',
        startLine: thread.anchor.startLine,
        endLine: thread.anchor.endLine,
        resolved: thread.resolved,
        messages: thread.messages.map(({ author, text }) => ({ author, html: markdownHtml(text) })),
        ...(publication === undefined ? {} : { url: publication.url }),
      };
    }),
  };
}
