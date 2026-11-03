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

export type DefinitionTarget = { readonly path: string } | { readonly peek: string };
type PageRange = { readonly path: string; readonly side: DiffSide; readonly startLine: number; readonly endLine: number };

/** What the page sends. The extension still validates each message, since the page renders untrusted HTML. */
export type PageMessage =
  | { readonly action: 'ready' | 'log' | 'retry' | 'refresh' | 'pr' }
  | { readonly action: 'publish' | 'github' | 'thread'; readonly id: string }
  | { readonly action: 'context' | 'preview' | 'editor'; readonly path: string }
  | (PageRange & { readonly action: 'comment'; readonly form: string; readonly text: string; readonly intent: CommentIntent })
  | (PageRange & { readonly action: 'github-comment'; readonly form: string; readonly text: string; readonly pending: boolean })
  | (PageRange & { readonly action: 'read'; readonly viewed: boolean })
  | { readonly action: 'unread'; readonly ids: readonly string[] }
  | { readonly action: 'reply' | 'github-reply'; readonly form: string; readonly id: string; readonly text: string }
  | { readonly action: 'resolve' | 'github-resolve'; readonly id: string; readonly resolved: boolean }
  | { readonly action: 'viewed'; readonly path: string; readonly viewed: boolean }
  | (DefinitionTarget & { readonly action: 'definition'; readonly line: number; readonly column: number })
  | (DefinitionTarget & { readonly action: 'probe'; readonly id: string; readonly line: number; readonly column: number })
  | { readonly action: 'open-definition'; readonly peek: string }
  | { readonly action: 'review'; readonly event: ReviewEvent; readonly body: string }
  | { readonly action: 'merge'; readonly method: MergeMethod };

/** What the extension sends the page; each field is handled on its own. */
export interface ExtensionMessage {
  readonly state?: OverviewState;
  readonly files?: readonly FileDiff[];
  readonly reveal?: string | undefined;
  readonly filesError?: string;
  readonly preview?: FilePreview & { readonly path: string };
  readonly context?: { readonly path: string; readonly lines: readonly string[] };
  readonly definition?: DefinitionPeek;
  readonly probe?: { readonly id: string; readonly found: boolean };
  readonly error?: string;
  /** The form whose send failed, so the page can enable it again. */
  readonly form?: string | undefined;
  /** The form whose send succeeded, or 'review'. */
  readonly done?: string | undefined;
  readonly idle?: true;
}

const reviewEvents: readonly ReviewEvent[] =['approve', 'requestChanges', 'comment'];
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
    if (revealPath !== undefined) void existing.webview.postMessage({ reveal: revealPath } satisfies ExtensionMessage).then(undefined, () => undefined);
    return;
  }
  let reveal = revealPath;
  let state = await read();
  const panel = vscode.window.createWebviewPanel('pairReview.pullRequestOverview', state.title, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources'), vscode.Uri.joinPath(extensionUri, 'dist')], retainContextWhenHidden: true });
  panels.set(key, panel);
  const resource = (...parts: string[]): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
  panel.webview.html = overviewHtml(state, resource('dist', 'overview.js'), resource('resources', 'claude-mark.svg'));
  const post = (message: ExtensionMessage): void => { void panel.webview.postMessage(message).then(undefined, () => undefined); };
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

/** The review page: PR overview on top, every changed file below. `script` (src/webview/overview.ts) draws it from state and file messages. */
export function overviewHtml(state: OverviewState, script: string, claudeIcon = ''): string {
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
.md-block.sel{background:var(--vscode-pairReview-selectionBackground,rgba(0,120,215,.18));border-left-color:var(--vscode-pairReview-selectionBorder,#0078d4)}
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
td.drag-sel,td.sel{box-shadow:inset 0 0 0 999px var(--vscode-pairReview-selectionBackground,rgba(0,120,215,.18))}
td.sel-start{box-shadow:inset 2px 0 0 var(--vscode-pairReview-selectionBorder,#0078d4),inset 0 0 0 999px var(--vscode-pairReview-selectionBackground,rgba(0,120,215,.18))}
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
<script id="initial" type="application/json">${JSON.stringify({ state, claudeIcon }).replaceAll('<', '\\u003c')}</script>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
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
