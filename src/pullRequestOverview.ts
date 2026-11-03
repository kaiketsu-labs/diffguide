import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { claudeStatus } from './claudeStatus.js';
import type { ReviewIntent, ReviewThread } from './contracts.js';
import type { PullRequestSession } from './pullRequestSessions.js';
import type { MergeMethod, PullRequestDetails, PullRequestSummary, RemoteThread, ReviewEvent } from './pullRequests.js';
import { webviewStyles } from './webviewStyles.js';
import { codicons } from './codicons.js';
import { codePreviewStyles } from './codePreview.js';
import { type MarkdownBlock, markdownHtml } from './markdown.js';
import type { FileDiff } from './unifiedDiff.js';
import type { DefinitionPeek } from './definitions.js';
import type { LineRange, ReadRange } from './reviewedFiles.js';
import type { Analysis } from './prAnalysis.js';
import type { MediaPreview } from './media.js';

/** Everything the review page shows for one PR, apart from the diff itself. */
export interface OverviewState {
  readonly title: string;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly changes?: { readonly additions: number; readonly deletions: number; readonly files: number };
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
    /** Set when the thread holds a note from Claude's analysis. */
    readonly origin?: 'analysis';
    /** Rendered from Markdown with escaped text only. */
    readonly messages: readonly { readonly author: 'human' | 'claude'; readonly html: string; readonly createdAt: string }[];
  }[];
  /** Diff comment threads on GitHub, by anyone; undefined while loading. */
  readonly github?: readonly GitHubThreadView[];
  readonly githubError?: string;
  /** Code host state; undefined while loading or when the host could not be reached. */
  readonly details?: PullRequestDetails;
  readonly detailsError?: string;
  readonly analysis: AnalysisView;
}

/** Claude's guided-review analysis: whether it runs, and the last result. */
export interface AnalysisView {
  readonly running: boolean;
  readonly step?: string;
  readonly error?: string;
  readonly result?: Analysis;
  /** The result was made for an older head commit. */
  readonly stale: boolean;
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
  readonly messages: readonly { readonly id: string; readonly author: string; readonly avatarUrl: string; readonly pending: boolean; readonly html: string; readonly canDelete: boolean; readonly createdAt: string }[];
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
  /** Delete one of the viewer's GitHub comments after they confirm. */
  deleteOnGitHub(commentId: string): Promise<void>;
  readFiles(): Promise<readonly FileDiff[]>;
  /** Every line of a changed file's PR version, highlighted, to expand context. */
  readContext(path: string): Promise<readonly string[]>;
  /** A Markdown file as rendered blocks, or an HTML file's source for a sandboxed frame. */
  readPreview(path: string): Promise<FilePreview>;
  /** A changed image, SVG or PDF before and after the PR. */
  readMedia(path: string): Promise<MediaPreview>;
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
  /** Ask for a new title in VS Code and save it. */
  editTitle(): Promise<void>;
  editBody(body: string): Promise<void>;
  /** Pick from the repository's users, teams or labels in VS Code and save the choice. */
  pick(what: PickTarget): Promise<void>;
  setDraft(draft: boolean): Promise<void>;
  setOpen(open: boolean): Promise<void>;
  deleteBranch(): Promise<void>;
  /** Remove the PR's local worktree after the user confirms; true when removed, so the page closes. */
  removeWorktree(): Promise<boolean>;
  refresh(): void;
  analyze(): Promise<void>;
  stopAnalysis(): void;
}

export type PickTarget = 'reviewers' | 'assignees' | 'labels';
const pickTargets: readonly unknown[] = ['reviewers', 'assignees', 'labels'] satisfies PickTarget[];

export type DefinitionTarget = { readonly path: string } | { readonly peek: string };
type PageRange = { readonly path: string; readonly side: DiffSide; readonly startLine: number; readonly endLine: number };

/** What the page sends. The extension still validates each message, since the page renders untrusted HTML. */
export type PageMessage =
  | { readonly action: 'ready' | 'log' | 'retry' | 'refresh' | 'pr' | 'analyze' | 'analysis-stop' | 'remove-worktree' }
  | { readonly action: 'publish' | 'github' | 'thread'; readonly id: string }
  | { readonly action: 'context' | 'preview' | 'media' | 'editor'; readonly path: string }
  | (PageRange & { readonly action: 'comment'; readonly form: string; readonly text: string; readonly intent: CommentIntent })
  | (PageRange & { readonly action: 'github-comment'; readonly form: string; readonly text: string; readonly pending: boolean })
  | (PageRange & { readonly action: 'read'; readonly viewed: boolean })
  | { readonly action: 'unread'; readonly ids: readonly string[] }
  | { readonly action: 'reply' | 'github-reply'; readonly form: string; readonly id: string; readonly text: string }
  | { readonly action: 'resolve' | 'github-resolve'; readonly id: string; readonly resolved: boolean }
  | { readonly action: 'github-delete'; readonly id: string }
  | { readonly action: 'viewed'; readonly path: string; readonly viewed: boolean }
  | (DefinitionTarget & { readonly action: 'definition'; readonly line: number; readonly column: number })
  | (DefinitionTarget & { readonly action: 'probe'; readonly id: string; readonly line: number; readonly column: number })
  | { readonly action: 'open-definition'; readonly peek: string }
  | { readonly action: 'view'; readonly view: 'files' | 'guide' }
  | { readonly action: 'review'; readonly event: ReviewEvent; readonly body: string }
  | { readonly action: 'merge'; readonly method: MergeMethod }
  | { readonly action: 'edit-title' | 'close' | 'reopen' | 'delete-branch' }
  | { readonly action: 'edit-body'; readonly body: string }
  | { readonly action: 'pick'; readonly what: PickTarget }
  | { readonly action: 'draft'; readonly draft: boolean };

/** What the extension sends the page; each field is handled on its own. */
export interface ExtensionMessage {
  readonly state?: OverviewState;
  readonly files?: readonly FileDiff[];
  readonly reveal?: string | undefined;
  /** A guide step's key: show the guided layout at that step. */
  readonly revealStep?: string | undefined;
  readonly filesError?: string;
  readonly preview?: FilePreview & { readonly path: string };
  readonly media?: MediaPreview & { readonly path: string };
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
/** Actions that change the PR on GitHub, one at a time. */
const pullRequestActions = new Set(['review', 'merge', 'edit-title', 'edit-body', 'pick', 'draft', 'close', 'reopen', 'delete-branch']);
const panels = new Map<string, vscode.WebviewPanel>();

const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= maximumReviewLength;

/** Where the review page scrolls when it opens: a file, or a step of the guided review. */
export type OverviewReveal = { readonly path: string } | { readonly step: string };

const revealMessage = (reveal: OverviewReveal | undefined): ExtensionMessage => reveal === undefined ? {} : 'path' in reveal ? { reveal: reveal.path } : { revealStep: reveal.step };

/** Show a PR's review page, reusing it when already open, and redraw it whenever `onDidChange` fires. */
export async function showPullRequestOverview(
  key: string, read: () => Promise<OverviewState>, onDidChange: vscode.Event<unknown>, actions: OverviewActions, extensionUri: vscode.Uri, revealAt?: OverviewReveal,
): Promise<void> {
  const existing = panels.get(key);
  if (existing !== undefined) {
    existing.reveal();
    if (revealAt !== undefined) void existing.webview.postMessage(revealMessage(revealAt)).then(undefined, () => undefined);
    return;
  }
  let reveal = revealAt;
  let state = await read();
  const panel = vscode.window.createWebviewPanel('pairReview.pullRequestOverview', state.title, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources'), vscode.Uri.joinPath(extensionUri, 'dist')], retainContextWhenHidden: true });
  panels.set(key, panel);
  const resource = (...parts: string[]): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
  panel.webview.html = overviewHtml(state, resource('dist', 'overview.js'), resource('resources', 'claude-spark.svg'), resource('dist', 'pdf.js'));
  const post = (message: ExtensionMessage): void => { void panel.webview.postMessage(message).then(undefined, () => undefined); };
  const sendFiles = (): void => {
    void actions.readFiles().then((files) => {
      post({ files, ...revealMessage(reveal) });
      reveal = undefined;
    }, (error: unknown) => {
      post({ filesError: error instanceof Error ? error.message : String(error) });
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by each read and each mark write; a read that is no longer the latest may predate a write, so it is dropped. */
  let generation = 0;
  const redraw = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const started = ++generation;
      void read().then((next) => {
        if (started !== generation) return;
        state = next;
        post({ state: next });
      }, () => undefined);
    }, 150);
  };
  const marking = async (write: Promise<void>): Promise<void> => {
    generation++;
    try { await write; } finally { redraw(); }
  };
  let busy = false;
  const subscriptions = [
    onDidChange(redraw),
    panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      const { action, id, ids, event, body, method, what, draft, path, viewed, side, startLine, endLine, text, intent, resolved, pending, form, peek, line, column, view } = value as Record<string, unknown>;
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
        } else if (action === 'github-delete' && typeof id === 'string' && state.github?.some((thread) => thread.messages.some((entry) => entry.id === id && entry.canDelete))) {
          await actions.deleteOnGitHub(id);
        }
        else if (action === 'context' && typeof path === 'string') post({ context: { path, lines: await actions.readContext(path) } });
        else if (action === 'preview' && typeof path === 'string') post({ preview: { path, ...await actions.readPreview(path) } });
        else if (action === 'media' && typeof path === 'string') post({ media: { path, ...await actions.readMedia(path) } });
        else if (action === 'definition' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0) {
          const found = await actions.findDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number);
          post(found === undefined ? { error: 'No definition found here. VS Code needs a language extension for this file type.' } : { definition: found });
        } else if (action === 'probe' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0
          && typeof id === 'string' && id.length <= 400) {
          const found = await actions.hasDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number).catch(() => false);
          post({ probe: { id, found } });
        } else if (action === 'open-definition' && typeof peek === 'string') await actions.openDefinition(peek);
        else if (action === 'view' && (view === 'files' || view === 'guide')) {
          await vscode.commands.executeCommand(view === 'guide' ? 'pairReview.showGuideInTree' : 'pairReview.showFilesInTree');
        } else if (action === 'log') actions.showLog();
        else if (action === 'retry') actions.retry();
        else if (action === 'analyze') await actions.analyze();
        else if (action === 'analysis-stop') actions.stopAnalysis();
        else if (action === 'remove-worktree') { if (await actions.removeWorktree()) panel.dispose(); }
        else if (action === 'refresh') {
          actions.refresh();
          sendFiles();
        } else if (action === 'pr') await vscode.env.openExternal(vscode.Uri.parse(state.url));
        else if (action === 'thread' && typeof id === 'string') await actions.revealThread(id);
        else if (action === 'viewed' && typeof path === 'string' && typeof viewed === 'boolean') await marking(actions.setViewed(path, viewed));
        else if (action === 'read' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && typeof viewed === 'boolean') await marking(actions.markRead({ path, side, startLine, endLine }, viewed));
        else if (action === 'unread' && Array.isArray(ids) && ids.length <= 1000 && ids.every((item) => typeof item === 'string')) await marking(actions.unmarkRead(ids as string[]));
        else if (action === 'editor' && typeof path === 'string') await actions.openInEditor(path);
        else if (action === 'github' && typeof id === 'string') {
          const url = [...state.threads, ...state.github ?? []].find((thread) => thread.id === id)?.url;
          if (url !== undefined) await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (typeof action === 'string' && pullRequestActions.has(action) && !busy) {
          busy = true;
          try {
            if (action === 'review' && reviewEvents.includes(event as ReviewEvent) && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.submitReview(event as ReviewEvent, body.trim());
              post({ done: 'review' });
            } else if (action === 'merge' && mergeMethods.includes(method as MergeMethod)) {
              await actions.merge(method as MergeMethod);
            } else if (action === 'edit-title') await actions.editTitle();
            else if (action === 'edit-body' && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.editBody(body);
              post({ done: 'body' });
            } else if (action === 'pick' && pickTargets.includes(what)) await actions.pick(what as PickTarget);
            else if (action === 'draft' && typeof draft === 'boolean') await actions.setDraft(draft);
            else if (action === 'close' || action === 'reopen') await actions.setOpen(action === 'reopen');
            else if (action === 'delete-branch') await actions.deleteBranch();
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
/** `pdfScript` is the URL of pdf.js, which the page loads on its first PDF. */
export function overviewHtml(state: OverviewState, script: string, claudeIcon = '', pdfScript?: string): string {
  const nonce = randomUUID().replaceAll('-', '');
  // Inline styles are allowed because an HTML preview frame inherits this policy; its sandbox still blocks scripts.
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Review</title>
<style nonce="${nonce}">
${webviewStyles}
${codePreviewStyles()}
body{margin:0;padding:var(--space-24) var(--space-24) 48px}
[hidden]{display:none!important}
h1{font-size:18px;line-height:26px;font-weight:600;margin:0;overflow-wrap:anywhere}
h2{font-size:14px;font-weight:600;margin:0}
h3{margin:0 0 var(--space-8);font-size:12px;line-height:18px;font-weight:600;color:var(--ink)}
.row{display:flex;align-items:center;gap:var(--space-8);flex-wrap:wrap}.head{justify-content:space-between}
.byline,.facts{margin-top:var(--space-6)}
.status{margin-top:var(--space-12);font-size:12px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--space-16);margin-top:var(--space-16);align-items:start}
@media (max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}}
.main-col{display:grid;gap:var(--space-16);min-width:0}
.card{padding:var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md)}
.rail{border:1px solid var(--line);border-radius:var(--radius-md)}.rail section{padding:var(--space-12)}.rail section+section{border-top:1px solid var(--line)}
.seg{display:inline-flex;gap:var(--space-2);padding:var(--space-2);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--ink) 7%,transparent)}
.seg button{min-height:22px;height:22px;padding:0 var(--space-8);border:0;border-radius:3px;color:var(--ink-muted);background:none;font-size:12px}
.seg button:hover{color:var(--ink);filter:none}
.seg button[aria-pressed=true]{color:var(--ink);background:var(--surface);box-shadow:0 0 0 1px var(--line);font-weight:600}
.seg.icons button{width:26px;padding:0}
.toolbar{display:flex;align-items:center;gap:var(--space-4)}.toolbar .divider{width:1px;height:16px;margin:0 var(--space-4);background:var(--line)}
.progress{display:inline-flex;align-items:center;gap:var(--space-8)}
.bar{width:160px;height:6px;border-radius:var(--radius-pill);background:color-mix(in srgb,var(--ink) 16%,transparent);overflow:hidden}
.bar span{display:block;height:100%;border-radius:inherit;background:var(--brand)}
.ref{min-height:20px;height:20px;gap:var(--space-4);padding:0 var(--space-6);border:0;color:var(--github);background:var(--github-soft);font:12px/18px var(--font-code)}
.ref:hover{filter:none}.ref svg{width:12px;height:12px;opacity:.55}.ref:hover svg,.ref:focus-visible svg{opacity:1}
.ref .done,.ref.copied .copy{display:none}.ref.copied .done{display:block;opacity:1}
ul{list-style:none;margin:0;padding:0}li{padding:var(--space-6) 0;font-size:12px}li+li{border-top:1px solid var(--line)}
.where{font-family:var(--font-code);font-size:12px}.text{overflow-wrap:anywhere}
.ok{color:var(--success)}.bad{color:var(--danger)}.wait{color:var(--warning)}
#body{overflow-wrap:anywhere;max-height:320px;overflow:auto}#body img{max-width:100%}#body pre{overflow:auto;padding:var(--space-8);border-radius:var(--radius-sm);background:var(--surface-sunken)}#body>:first-child{margin-top:0}#body>:last-child{margin-bottom:0}
textarea{width:100%;min-height:80px}
.actions,.spaced{margin-top:var(--space-8)}
.review-actions{justify-content:flex-end}
.title-row{display:flex;align-items:center;gap:var(--space-4);min-width:0}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-8);margin-bottom:var(--space-8)}.section-head h3{margin:0}.section-head .icon-button{width:22px;height:22px;min-height:22px;margin:-2px 0}
.labels{display:flex;flex-wrap:wrap;gap:var(--space-4)}.label{display:inline-flex;align-items:center;gap:var(--space-6);height:20px;padding:0 var(--space-8);border:1px solid color-mix(in srgb,var(--label) 55%,transparent);border-radius:var(--radius-pill);font-size:12px;background:color-mix(in srgb,var(--label) 16%,transparent)}.label::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--label)}
.state-actions:not(:empty){margin-top:var(--space-8)}.state-actions .gap{flex:1}#body textarea{width:100%;min-height:120px}
.verdict{display:inline-flex;align-items:center;height:24px;box-sizing:border-box;padding:0 var(--space-12);border:1px solid currentColor;border-radius:var(--radius-pill);font-size:12px;font-weight:600}
.verdict.muted{color:var(--ink-muted)}
#error{position:fixed;left:var(--space-24);right:var(--space-24);bottom:var(--space-16);z-index:5;max-width:520px;margin:0;padding:var(--space-8) var(--space-12);border:1px solid var(--danger);border-radius:var(--radius-lg);color:var(--ink);background:linear-gradient(var(--danger-soft),var(--danger-soft)),var(--surface-raised);box-shadow:var(--shadow-overlay);white-space:pre-wrap;cursor:pointer}#error:empty{display:none}
#files-bar{position:sticky;top:0;z-index:2;margin-top:var(--space-24);padding:var(--space-8) 0;background:var(--surface);border-bottom:1px solid var(--line)}
#files-bar h2 .muted{font-weight:400}
.view-head{gap:var(--space-12)}.tabs{display:flex;gap:var(--space-4)}
.tabs button{display:inline-flex;align-items:center;gap:var(--space-6);min-height:28px;padding:0 var(--space-8);border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--ink-muted);background:none;font-size:14px;font-weight:600}
.tabs button:hover{color:var(--ink);filter:none}.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}
.tabs svg{width:16px;height:16px;fill:currentColor}
.tabs .count{min-width:18px;height:18px;padding:0 var(--space-6);border-radius:var(--radius-pill);font-size:11px;font-weight:600;line-height:18px;text-align:center;color:var(--ink);background:color-mix(in srgb,var(--ink) 12%,transparent)}.tabs .count:empty:not(.working){display:none}
.tabs .count.working{min-width:0;width:8px;height:8px;padding:0;background:var(--claude);animation:pulse 1.2s ease-in-out infinite}
.off-view{display:none}
.file{margin-top:var(--space-12);border:1px solid var(--line-strong);border-top:0;border-radius:var(--radius-md);scroll-margin-top:calc(var(--bar-height,46px) + 10px)}
.file-head{position:sticky;top:var(--bar-height,46px);z-index:1;box-shadow:0 -12px 0 var(--surface);display:flex;align-items:center;gap:var(--space-8);margin:0 -1px;padding:var(--space-6) var(--space-12);background:var(--surface-raised);border:1px solid var(--line-strong);border-bottom-color:var(--line);border-radius:var(--radius-md) var(--radius-md) 0 0}
.file.collapsed{border:0}.file.collapsed .file-head{margin:0;border-bottom-color:var(--line-strong);border-radius:var(--radius-md)}.file.collapsed .diff{display:none}
.file-head .name{font-family:var(--font-code);font-size:12px;overflow-wrap:anywhere;flex:1;cursor:pointer}
.chevron,.thread>summary::before{display:inline-block;flex-shrink:0;width:16px;height:16px;vertical-align:-3px;color:var(--ink-muted);background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.146 5.854l4.5 4.5a.5.5 0 0 0 .707 0l4.5-4.5a.5.5 0 0 0-.707-.707L8 9.293 3.854 5.147a.5.5 0 0 0-.708.707z'/%3E%3C/svg%3E") center/16px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.146 5.854l4.5 4.5a.5.5 0 0 0 .707 0l4.5-4.5a.5.5 0 0 0-.707-.707L8 9.293 3.854 5.147a.5.5 0 0 0-.708.707z'/%3E%3C/svg%3E") center/16px no-repeat;transition:transform .1s}.chevron{cursor:pointer}.chevron.closed,.thread:not([open])>summary::before{transform:rotate(-90deg)}.badge{width:14px;font:700 11px var(--font-code);text-align:center}
.badge.added{color:var(--git-added)}.badge.modified{color:var(--git-modified)}.badge.deleted{color:var(--git-deleted)}.badge.renamed{color:var(--git-renamed)}
.stats{font:12px var(--font-code)}.stat-add{color:var(--git-added)}.stat-del{color:var(--git-deleted)}
label.viewed{display:inline-flex;align-items:center;gap:var(--space-4);height:22px;box-sizing:border-box;padding:0 var(--space-8);border:1px solid var(--line-strong);border-radius:var(--radius-sm);font-size:12px;cursor:pointer}
label.viewed:has(input:checked){color:var(--brand);font-weight:600;background:color-mix(in srgb,var(--ink) 6%,transparent)}
label.viewed input,label.check input{margin:0;accent-color:var(--brand)}
.file-head button{min-height:22px;padding:0 var(--space-8);font-size:12px}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-family:var(--vscode-editor-font-family,var(--font-code));font-size:var(--vscode-editor-font-size,12px);line-height:1.6}
col.num{width:52px}td{vertical-align:top;padding:0}
td.num{text-align:right;padding:0 var(--space-8);color:var(--vscode-editorLineNumber-foreground,var(--ink-muted));user-select:none}
td.code{white-space:pre-wrap;word-break:break-all;padding:0 10px 0 18px;text-indent:-10px}
td.code::before{content:'';display:inline-block;width:10px;color:var(--ink-muted)}
tr.add td.code::before{content:'+'}tr.del td.code::before{content:'-'}td.code.add::before{content:'+'}td.code.del::before{content:'-'}
tr.add td,td.add{background:var(--diff-add)}
tr.del td,td.del{background:var(--diff-del)}
td.empty{background:color-mix(in srgb,var(--ink) 4%,transparent)}
tr.hunk td{padding:var(--space-2) var(--space-12);color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 6%,transparent);font-size:11px}
tr.read-run td{padding:var(--space-2) var(--space-12);color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 3%,transparent);box-shadow:inset 2px 0 0 var(--brand);font-family:var(--font-ui);font-size:11px}
tr.read-run .read-label{cursor:pointer;margin-right:10px}
tr.read-run button,.expand button{min-height:18px;padding:0 var(--space-8);font-size:11px;line-height:1.6}
.expand{display:inline-flex;gap:var(--space-2);margin-right:10px}
.composer-actions{gap:var(--space-8);margin-top:var(--space-8)}.composer-actions .gap,.actions .gap{flex:1}
label.check{display:flex;align-items:center;gap:var(--space-6);padding-left:var(--space-12);border-left:1px solid var(--line);cursor:pointer;font-size:12px}.strip label.check{padding-left:10px;margin-left:2px}.strip .muted:has(+label.check){margin-left:auto}
td.code.linked{cursor:pointer}::highlight(lr-link){color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground));text-decoration:underline}
::highlight(lr-name){background-color:var(--vscode-editor-wordHighlightStrongBackground,rgba(255,213,0,.3))}
#peek{position:fixed;top:var(--space-8);right:var(--space-8);bottom:var(--space-8);z-index:6;width:var(--peek-width,min(560px,92vw));max-width:calc(100vw - 2 * var(--space-8));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface-raised);box-shadow:var(--shadow-overlay)}
.peek-head{display:flex;align-items:center;gap:var(--space-8);padding:var(--space-8) 10px;border-bottom:1px solid var(--line)}.peek-head .where{flex:1;overflow-wrap:anywhere}
.peek-head button{min-height:24px;padding:0 var(--space-6)}.peek-head button[disabled]{opacity:.4;cursor:default}.peek-head svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.media{display:flex;flex-wrap:wrap;gap:var(--space-12);padding:var(--space-12)}
.media-side{flex:1 1 280px;min-width:0;margin:0;display:flex;flex-direction:column;gap:var(--space-6)}
.media-side figcaption{font-size:12px}
.media-side img{max-width:100%;max-height:600px;align-self:flex-start;border:1px solid var(--line);border-radius:var(--radius-sm);background:repeating-conic-gradient(color-mix(in srgb,var(--ink) 10%,transparent) 0 25%,transparent 0 50%) 0 0/16px 16px}
.pdf-pages{display:flex;flex-direction:column;gap:var(--space-8);max-height:900px;overflow:auto}.pdf-pages canvas{max-width:100%;height:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}
#peek-code{flex:1;overflow:auto}
#peek-resize{position:absolute;left:0;top:0;bottom:0;z-index:1;width:6px;cursor:ew-resize}#peek-resize:hover,body.resizing #peek-resize{background:var(--brand-line)}body.resizing{cursor:ew-resize;user-select:none}tr.focus td{background:var(--vscode-editor-rangeHighlightBackground,rgba(255,213,0,.12))}
.note{padding:10px 14px}
.preview.md{padding:var(--space-8) 20px var(--space-12);font-family:var(--font-ui);line-height:1.6;overflow-wrap:anywhere}
.md-block{margin:0 -10px;padding:1px 10px;border-left:2px solid transparent;border-radius:var(--radius-sm);cursor:pointer}
.md-block:hover{background:color-mix(in srgb,var(--ink) 6%,transparent);border-left-color:var(--brand-line)}
.md-block.sel{background:var(--brand-soft);border-left-color:var(--brand-line)}
.preview.md>.thread{margin:4px 0 10px}
.md-block h1,.md-block h2{padding-bottom:4px;border-bottom:1px solid var(--line)}.md-block h1{font-size:1.8em}.md-block h2{font-size:1.4em}.md-block h3{font-size:1.15em}
.md-block code,.msg-text code{font-family:var(--font-code);font-size:.92em;padding:1px var(--space-4);border-radius:var(--radius-sm);background:var(--surface-sunken)}
.md-block pre,.msg-text pre{padding:var(--space-8) 10px;border:1px solid var(--line);border-radius:var(--radius-md);overflow:auto;background:var(--surface-sunken)}.md-block pre code,.msg-text pre code{padding:0;background:none}
.md-block table{border-collapse:collapse}.md-block th,.md-block td{padding:4px 10px;border:1px solid var(--line)}
.md-block blockquote,.msg-text blockquote{margin:var(--space-8) 0;padding-left:var(--space-12);border-left:3px solid var(--line);color:var(--ink-muted)}.md-block img,.msg-text img{max-width:100%}
.md-block hr{border:0;border-top:1px solid var(--line)}
.html-preview{display:block;width:100%;border:0}
.html-split{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--space-12);padding:0 var(--space-12) var(--space-12) 0}.html-margin{position:relative}.html-margin>.thread{position:absolute;left:0;right:0;margin:0}
@media (max-width:760px){.html-split{grid-template-columns:1fr;padding-right:0}.html-margin>.thread{position:static;margin:8px 12px}}
td.num.pick{cursor:pointer;position:relative}
td.num.pick:hover::after,td.num.pick:has(+td.code:hover)::after,td.num.pick:has(+td.num:not(.pick)+td.code:hover)::after{content:'+';position:absolute;top:50%;right:-16px;z-index:1;width:20px;height:20px;margin-top:-10px;border-radius:var(--radius-sm);font:600 15px/20px var(--font-ui);text-align:center;color:var(--on-brand);background:var(--brand)}td.num.pick:hover{color:var(--brand);background:color-mix(in srgb,var(--ink) 10%,transparent)}
td.drag-sel,td.sel{box-shadow:inset 0 0 0 999px var(--brand-soft)}
td.sel-start{box-shadow:inset 2px 0 0 var(--brand-line),inset 0 0 0 999px var(--brand-soft)}
tr.inline>td{padding:var(--space-6) 10px var(--space-8)}
.thread{--accent:var(--claude);--tint:var(--claude-soft);max-width:860px;box-sizing:border-box;padding:0 var(--space-12) var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;background:var(--surface-raised);font:13px/20px var(--font-ui)}
.thread.github{--accent:var(--github);--tint:var(--github-soft)}.thread.pending,.thread.draft{border:1px dashed var(--accent)}
.thread+.thread{margin-top:var(--space-6)}
.thread>summary,.thread>.strip{display:flex;align-items:center;gap:var(--space-8);flex-wrap:wrap;margin:0 calc(-1 * var(--space-12));padding:var(--space-4) var(--space-12);font-size:12px;line-height:18px;background:var(--tint);border-bottom:1px solid var(--line)}
.thread:not([open])>summary{border-bottom:0}
.thread>summary{cursor:pointer;list-style:none}.thread>summary::-webkit-details-marker{display:none}
.thread>summary::before{content:''}details.thread:not([open]){padding-bottom:0}
.source{display:inline-flex;align-items:center;gap:var(--space-4);font-weight:600;color:var(--accent)}.source svg{width:14px;height:14px;fill:currentColor}
.strip .muted:last-child{margin-left:auto}
.thread textarea{margin-top:var(--space-12);min-height:64px}
.msg{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:var(--space-8);margin-top:var(--space-8)}.msg+.msg{padding-top:var(--space-8);border-top:1px solid var(--line)}
.msg .avatar{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;color:var(--ink-muted)}.msg .avatar.claude{box-sizing:border-box;padding:2px;border-radius:0}.msg .avatar svg{width:20px;height:20px;fill:currentColor}
.msg-head{display:flex;align-items:center;gap:var(--space-6);min-height:20px}.msg-head b{font-weight:600}.msg-head .msg-meta{margin-left:auto}
.msg-meta{display:flex;align-items:center;gap:var(--space-6)}.msg-main>.msg-meta{float:right;margin-left:var(--space-12)}.when{font-size:12px;color:var(--ink-muted)}
.pill{padding:0 var(--space-6);border:1px solid var(--warning);border-radius:var(--radius-pill);font-size:11px;font-weight:500;color:var(--warning)}
.msg-text{overflow-wrap:anywhere}.msg-text>:first-child{margin-top:0}.msg-text>:last-child{margin-bottom:0}
.msg-text p,.msg-text ul,.msg-text ol,.msg-text pre,.msg-text blockquote{margin:var(--space-6) 0}.msg-text ul,.msg-text ol{padding-left:20px}.msg-text ul{list-style:disc}.msg-text li{padding:1px 0;border:0;font-size:inherit}
.outside{padding:var(--space-8) 10px;border-bottom:1px solid var(--line)}.outside>.muted{margin-bottom:var(--space-6);font-size:12px}
.comments{font-size:12px}
.card-thread{--accent:var(--claude)}.card-thread.github{--accent:var(--github)}.card-thread .source{font-size:12px}
.main-col{grid-template-columns:minmax(0,1fr)}
.file{scroll-margin-top:calc(var(--bar-height,46px) + var(--depth,0) * 32px + 10px)}
.file-head{top:calc(var(--bar-height,46px) + var(--depth,0) * 32px)}
.thread.local,.card-thread.local,.thread-group.local{--accent:var(--ink-muted);--tint:color-mix(in srgb,var(--ink) 5%,transparent)}
.thread.analysis,.card-thread.analysis,.thread-group.analysis{--accent:var(--claude);--tint:var(--claude-soft)}
.thread.github,.card-thread.github,.thread-group.github{--accent:var(--github);--tint:var(--github-soft)}
.strip .gap{flex:1}.pill.state{border-color:var(--line-strong);color:var(--ink-muted)}
.msg .delete{min-height:20px;padding:0 var(--space-2)}.msg .delete svg{width:14px;height:14px}.msg .delete:hover{color:var(--danger);text-decoration:none}
details.thread .composer-actions button{min-height:24px;padding:0 10px;font-size:12px}
.chip.bad{color:var(--danger);background:var(--danger-soft)}
.guide-intro{margin-top:var(--space-12)}.guide-intro p{margin:var(--space-6) 0}
.tree-node{margin-top:var(--space-12)}
.node-head{position:sticky;top:calc(var(--bar-height,46px) + var(--depth,0) * 32px);z-index:2;box-sizing:border-box;height:32px;display:flex;align-items:center;gap:var(--space-8);padding:0 10px;background:var(--surface);cursor:pointer;user-select:none}
.folder-head .name{flex:1;font-family:var(--font-code);font-size:12px;overflow-wrap:anywhere}.node-head .progress{font-size:12px}
.fold-rail{--rail:var(--line-strong);position:relative;margin-left:17px}.fold-rail:has(>.fold-line:hover){--rail:var(--focus)}
.fold-line{position:absolute;left:-5px;top:0;bottom:0;width:12px;cursor:pointer;z-index:1}
.rail-item{position:relative;display:flow-root;padding:var(--space-8) 0 0 var(--space-16);overflow:clip}.fold-rail>.rail-item>*{margin-top:0}.step-wrap>.transition:first-child{margin-top:0}.step-wrap>.file:first-child{margin-top:0}
.rail-item:not(:last-child)::after{content:'';position:absolute;left:0;top:0;bottom:0;border-left:2px solid var(--rail)}
.rail-item:has(>.tree-node)::before,.rail-item>.file::before,.rail-item>.step-wrap>.file::before{content:'';position:absolute;left:0;top:0;width:12px;height:25px;border-left:2px solid var(--rail);border-bottom:2px solid var(--rail);border-bottom-left-radius:var(--radius-lg)}
.rail-item>.file,.rail-item>.step-wrap>.file{position:relative}.rail-item>.file::before,.rail-item>.step-wrap>.file::before{left:-17px;top:auto;bottom:calc(100% - 21px);height:400px}
.fold-toggle{display:inline-flex;flex:none;width:16px;height:16px;color:var(--ink-muted)}.node-head:hover .fold-toggle{color:var(--focus)}.fold-toggle svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}
.step-wrap{scroll-margin-top:calc(var(--bar-height,46px) + var(--depth,0) * 32px + 10px)}
.step-title{font-family:var(--font-ui);font-size:13px;font-weight:600;margin-right:var(--space-8)}.step-path{color:var(--ink-muted)}
.guide-group{margin-top:var(--space-24)}
.guide-group .sev{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-8);border-radius:var(--radius-pill);font-size:12px;font-weight:600;color:var(--sev);background:var(--sev-soft)}
.guide-group .title{flex:1;font-weight:600;overflow-wrap:anywhere}.guide-group .progress{font-size:12px;color:var(--ink-muted)}
.sev-critical{--sev:var(--danger);--sev-soft:var(--danger-soft)}.sev-significant{--sev:var(--warning);--sev-soft:color-mix(in srgb,var(--warning) 14%,transparent)}
.sev-routine{--sev:var(--ink);--sev-soft:color-mix(in srgb,var(--ink) 9%,transparent)}.sev-trivial,.sev-unclassified{--sev:var(--ink-muted);--sev-soft:color-mix(in srgb,var(--ink) 5%,transparent)}
.transition{margin:var(--space-12) 0 0 14px;font-size:12px;line-height:18px;color:var(--ink-muted)}.step-wrap>.transition+.file{margin-top:var(--space-12)}
.file-note,.step-note{padding:var(--space-8) var(--space-12);border-bottom:1px solid var(--line)}.file-note .tag{font-size:12px;font-weight:600;color:var(--claude)}
.step>.diff>.thread{max-width:none;margin:var(--space-8) 10px}
.thread-group{padding:var(--space-2) 0}.thread-group-head{display:flex;align-items:center;gap:var(--space-6);padding:var(--space-4) 0;cursor:pointer;user-select:none}
.card-thread{display:grid;grid-template-columns:minmax(0,11em) minmax(0,1fr) auto auto;align-items:baseline;column-gap:var(--space-12);padding:var(--space-2) var(--space-6) var(--space-2) var(--space-8);border-left:2px solid var(--accent);font-size:12px;cursor:pointer}.card-thread+.card-thread{border-top:0}.card-thread:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
.card-thread .name,.card-thread .text{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.card-thread .where{display:flex;min-width:0;font-family:var(--font-code);color:var(--ink-muted)}.card-thread .state{color:var(--ink-muted)}
.card-thread code{font-family:var(--font-code);font-size:.92em}
.toolbar button.icon-button[aria-pressed=true]{color:var(--ink);background:color-mix(in srgb,var(--ink) 12%,transparent)}
</style></head><body>
<div class="row head"><span class="title-row"><h1 id="title"></h1><button id="edit-title" class="icon-button" data-pr-action data-tip="Edit title" aria-label="Edit title" hidden>${codicons.edit}</button></span><span class="row"><a id="pr">Open on GitHub</a><a id="refresh">Refresh</a><a id="remove-worktree">Remove worktree</a></span></div>
<div class="row byline"><span id="byline" class="row muted"></span><span id="verdict" class="verdict" hidden></span></div>
<div id="facts" class="muted facts"></div>
<div class="row status"><div class="progress" id="reviewed"></div><span id="claude"></span><button id="log" class="quiet">Show log</button><button id="retry" class="small">Retry</button></div>
<p id="error" role="alert"></p>
<aside id="peek" hidden aria-label="Definition"><div id="peek-resize" title="Drag to resize. Double-click to reset."></div><div class="peek-head">
<button id="peek-back" title="Back" aria-label="Back"><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button>
<button id="peek-forward" title="Forward" aria-label="Forward"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button>
<span id="peek-title" class="where"></span>
<button id="peek-open" title="Open in editor"><svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>Open in editor</button>
<button id="peek-close" title="Close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div><div id="peek-code"></div></aside>
<div class="layout">
<div class="main-col">
<section class="card"><div class="section-head"><h3>Description</h3><button id="edit-body" class="icon-button" data-pr-action data-tip="Edit description" aria-label="Edit description" hidden>${codicons.edit}</button></div><div id="body"></div></section>
<section class="card"><h3 id="threads-title">Threads</h3><ul id="threads"></ul></section>
</div>
<aside class="rail">
<section><div class="section-head"><h3>Reviewers</h3><button id="pick-reviewers" class="icon-button" data-pr-action data-tip="Request reviewers" aria-label="Request reviewers" hidden>${codicons.gear}</button></div><ul id="reviewers"></ul></section>
<section><div class="section-head"><h3>Assignees</h3><button id="pick-assignees" class="icon-button" data-pr-action data-tip="Edit assignees" aria-label="Edit assignees" hidden>${codicons.gear}</button></div><ul id="assignees"></ul></section>
<section><div class="section-head"><h3>Labels</h3><button id="pick-labels" class="icon-button" data-pr-action data-tip="Edit labels" aria-label="Edit labels" hidden>${codicons.gear}</button></div><div id="labels" class="labels"></div></section>
<section><h3>Checks</h3><ul id="checks"></ul></section>
<section id="review-box"><h3>Finish your review</h3>
<p class="muted" id="pending-note"></p>
<textarea id="review" placeholder="Leave a summary (optional for approval)" aria-label="Review summary"></textarea>
<div class="row actions review-actions"><button data-event="comment">Comment</button><button data-event="requestChanges" data-reviewer>Request changes</button><button class="primary" data-event="approve" data-reviewer>Approve</button></div>
<p class="muted" id="review-note"></p></section>
<section id="merge-box"><h3 id="merge-title">Merge</h3><div class="row" id="merge-row"><select id="method" aria-label="Merge method"></select><button id="merge">Merge</button></div><p id="mergeable" class="muted"></p><div class="row state-actions" id="state-actions"></div></section>
</aside>
</div>
<div id="files-bar" class="row head"><span class="row view-head"><span class="tabs" role="tablist" aria-label="Show">
<button id="view-files" role="tab">Files<span id="files-count" class="count"></span></button>
<button id="view-guide" role="tab">${codicons.map}Guide<span id="guide-count" class="count" hidden></span></button></span>
<span id="files-title" class="muted"></span></span><span class="toolbar">
<span id="analysis-status"></span><button id="analyze" class="small">Build guide</button>
<span id="analyze-divider" class="divider"></span>
<span class="seg icons" role="group" aria-label="Diff layout"><button id="unified" data-tip="Unified diff" aria-label="Unified diff">${codicons.listFlat}</button><button id="split" data-tip="Side-by-side diff" aria-label="Side-by-side diff">${codicons.splitHorizontal}</button></span>
<button id="folders" class="icon-button" data-tip="Group files by folder" aria-label="Group files by folder">${codicons.listTree}</button>
<span class="divider"></span>
<button id="collapse" class="icon-button" data-tip="Collapse all files" aria-label="Collapse all files">${codicons.collapseAll}</button>
<button id="expand" class="icon-button" data-tip="Expand all files" aria-label="Expand all files">${codicons.expandAll}</button>
<button id="toggle-comments" class="icon-button" data-tip="Collapse all comments" aria-label="Collapse all comments">${codicons.comment}</button></span></div>
<div id="files"><p class="muted">Loading changes…</p></div>
<script id="initial" type="application/json">${JSON.stringify({ state, claudeIcon, pdfScript }).replaceAll('<', '\\u003c')}</script>
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
    messages: thread.comments.map(({ id, author, avatarUrl, pending, bodyHtml, canDelete, createdAt }) => ({ id, author, avatarUrl, pending, html: bodyHtml, canDelete, createdAt })),
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
  details?: PullRequestDetails | Error, remote?: readonly RemoteThread[] | Error, analysis: AnalysisView = { running: false, stale: false },
): OverviewState {
  const { session, runner } = opened;
  const claude = claudeStatus(runner.activity);
  return {
    title: `#${pullRequest.number} ${pullRequest.title}`,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    url: pullRequest.url,
    ...(pullRequest.createdAt === undefined ? {} : { createdAt: pullRequest.createdAt }),
    ...(pullRequest.updatedAt === undefined ? {} : { updatedAt: pullRequest.updatedAt }),
    ...(pullRequest.changes === undefined ? {} : { changes: pullRequest.changes }),
    viewed,
    read,
    ...(total === undefined ? {} : { reviewed: { done: viewed.length, total } }),
    ...(details === undefined ? {} : details instanceof Error ? { detailsError: details.message } : { details }),
    ...(remote === undefined ? {} : remote instanceof Error ? { githubError: remote.message } : { github: remote.map(githubThreadView) }),
    claude: { text: claude.text, running: runner.activity.running, retry: claude.retry },
    analysis,
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
        ...(thread.origin === undefined ? {} : { origin: thread.origin }),
        messages: thread.messages.map(({ author, text, createdAt }) => ({ author, html: markdownHtml(text), createdAt })),
        ...(publication === undefined ? {} : { url: publication.url }),
      };
    }),
  };
}
