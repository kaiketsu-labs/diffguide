import * as path from 'node:path';
import * as vscode from 'vscode';

import { capturedCodeContext, hashDocumentText, locateCodeAnchor, type AnchorLocation } from './anchors.js';
import { createComposer, type ComposerRequest, type ComposerSubmission } from './composer.js';
import { parseComposerInput } from './composerIntent.js';
import { createCodeNavigation } from './codeNavigation.js';
import { normalizeInlineReply } from './gutter.js';
import type { CodeAnchor, ReviewIntent, ReviewMessage, ReviewStore, ReviewThread } from './contracts';
import { getHeadRevision, isWorkspaceRelativePath, listChangedFiles, readGitBase } from './git';
import { SubmissionGate } from './submissionGate.js';
import { resolvedVisibilityKey, ReviewVisibility } from './reviewVisibility.js';
import { anchorDocumentUri, type ReviewSession, type ReviewSessionSource, type SessionLocation } from './reviewSession.js';

const controllerId = 'diffGuide';
const baseScheme = 'diffguide-base';
const contextScheme = 'diffguide-context';
const intentLabels: Record<ReviewIntent, string> = {
  ask: 'Frage',
  implement: 'Umsetzung',
  summarize: 'Zusammenfassung',
};
const statusLabels: Record<ReviewThread['status'], string> = {
  queued: 'Wartet auf Claude',
  received: 'Bei Claude',
  working: 'Claude arbeitet',
  answered: 'Beantwortet',
  ready: 'Zur Prüfung',
};

interface BaseReference {
  readonly relativePath: string;
  readonly revision: string;
  readonly emptyWorking: boolean;
}

interface ThreadBinding {
  readonly native: vscode.CommentThread;
  startOffset: number;
  endOffset: number;
  documentVersion: number;
  currentHash: string;
}

interface LocatedDocument {
  readonly document: vscode.TextDocument;
  readonly range: vscode.Range;
  readonly captured: boolean;
}

interface RenderedComments {
  readonly messages: readonly ReviewMessage[];
  readonly comments: readonly vscode.Comment[];
}

/** Hash the full document so restored comments never silently change versions. */
function documentHash(document: vscode.TextDocument): string {
  return hashDocumentText(document.getText());
}

/** Convert a confirmed line location into the native editor's full-line range. */
function locationRange(document: vscode.TextDocument, location: AnchorLocation): vscode.Range {
  return document.validateRange(new vscode.Range(location.startLine - 1, 0, location.endLine - 1, Number.MAX_SAFE_INTEGER));
}

/** Identify the saved excerpt separately from both the Git base and mutable working code. */
function contextUri(thread: ReviewThread): vscode.Uri {
  return vscode.Uri.from({
    scheme: contextScheme,
    path: `/${thread.anchor.path}`,
    query: new URLSearchParams({ thread: thread.id }).toString(),
  });
}

/** Read and validate the metadata of a review-owned virtual document. */
function baseReference(uri: vscode.Uri): BaseReference | undefined {
  if (uri.scheme !== baseScheme) {
    return undefined;
  }
  const query = new URLSearchParams(uri.query);
  const relativePath = query.get('path');
  const revision = query.get('revision');
  if (relativePath === null || !isWorkspaceRelativePath(relativePath)
    || revision === null || !(revision === 'unborn' || /^[a-f\d]{40,64}$/u.test(revision))) {
    return undefined;
  }
  return { relativePath, revision, emptyWorking: query.get('emptyWorking') === 'true' };
}

/** Build an immutable original document, or an empty side for a deleted file. */
function baseUri(relativePath: string, revision: string, emptyWorking = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: baseScheme,
    path: `/${relativePath}`,
    query: new URLSearchParams({ path: relativePath, revision, emptyWorking: String(emptyWorking) }).toString(),
  });
}

/** Locate local files and snapshots belonging to this workspace. */
function localLocation(uri: vscode.Uri, workspaceRoot: string): SessionLocation | undefined {
  if (uri.scheme === baseScheme) {
    const reference = baseReference(uri);
    return reference === undefined ? undefined
      : { path: reference.relativePath, original: !reference.emptyWorking, revision: reference.revision };
  }
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const relativePath = path.relative(workspaceRoot, uri.fsPath);
  return isWorkspaceRelativePath(relativePath) ? { path: relativePath.split(path.sep).join('/'), original: false } : undefined;
}

/** Keep a full line selection so gutter comments retain useful code context. */
function lineRange(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
  const valid = document.validateRange(range);
  const lastLine = valid.end.character === 0 && valid.end.line > valid.start.line
    ? valid.end.line - 1
    : valid.end.line;
  return new vscode.Range(valid.start.line, 0, lastLine, document.lineAt(lastLine).text.length);
}

/** Render review text while allowing only the host's validated code-navigation actions. */
function nativeComment(
  message: ReviewMessage, first: boolean, author: vscode.CommentAuthorInformation, body: vscode.MarkdownString,
): vscode.Comment {
  return {
    body,
    author,
    label: message.author === 'claude' ? 'Answer' : first ? 'Comment' : 'Reply',
    mode: vscode.CommentMode.Preview,
    timestamp: new Date(message.createdAt),
  };
}

/** Map an existing boundary through an edit while preserving surrounding selections. */
function mapOffset(offset: number, change: vscode.TextDocumentContentChangeEvent, endBoundary: boolean): number {
  const changeEnd = change.rangeOffset + change.rangeLength;
  if (offset < change.rangeOffset) {
    return offset;
  }
  if (offset > changeEnd) {
    return offset + change.text.length - change.rangeLength;
  }
  return change.rangeOffset + (endBoundary ? change.text.length : 0);
}

/** Thread context value; PR threads also say whether they can be posted or are already on the code host. */
function threadContext(session: ReviewSession, thread: ReviewThread): string {
  const base = thread.resolved ? 'diffGuide.resolved' : 'diffGuide.open';
  if (session.publish === undefined) return base;
  return `${base}.${session.publication?.(thread.id) === undefined ? 'publishable' : 'published'}`;
}

/** " · On GitHub" for a posted thread. */
function publicationLabel(session: ReviewSession, thread: ReviewThread): string {
  const publication = session.publication?.(thread.id);
  return publication === undefined ? '' : publication.pending ? ' · On GitHub (pending)' : ' · On GitHub';
}

/** Compact native sidebar entry linked to its original review conversation. */
class ReviewItem extends vscode.TreeItem {
  readonly threadId: string;

  constructor(thread: ReviewThread, session: ReviewSession, activity: string | undefined) {
    const sessionLabel = session.label;
    const firstMessage = thread.messages[0]?.text.replaceAll(/\s+/gu, ' ') ?? 'Review-Kommentar';
    super(`${path.basename(thread.anchor.path)}:${thread.anchor.startLine} · ${firstMessage.slice(0, 90)}`, vscode.TreeItemCollapsibleState.None);
    this.threadId = thread.id;
    this.id = thread.id;
    const status = `${thread.resolved ? 'Erledigt' : `${activity ?? statusLabels[thread.status]}${thread.outdated ? ' · Kontext geändert' : ''}`}${publicationLabel(session, thread)}`;
    this.description = `${sessionLabel ? `${sessionLabel} · ` : ''}${intentLabels[thread.intent]} · ${status}`;
    this.contextValue = threadContext(session, thread);
    this.iconPath = new vscode.ThemeIcon(thread.resolved ? 'pass' : thread.outdated ? 'warning' : thread.status === 'working' || activity !== undefined ? 'sync~spin' : 'comment-discussion');
    this.command = { command: 'diffGuide.revealThread', title: 'Zum Kommentar springen', arguments: [thread.id] };
    this.tooltip = new vscode.MarkdownString()
      .appendText(`${thread.anchor.path}:${thread.anchor.startLine}\n${intentLabels[thread.intent]} · ${status}\n\n${firstMessage}`);
  }
}

/** Expose durable review conversations through VS Code's native tree view. */
class ReviewTree implements vscode.TreeDataProvider<ReviewItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ReviewItem | undefined>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(private readonly sessions: () => readonly ReviewSession[], private readonly visibility: ReviewVisibility) {}

  /** Invalidate the native list after review storage changes. */
  refresh(): void {
    this.changes.fire(undefined);
  }

  /** Return the already prepared native entry. */
  getTreeItem(item: ReviewItem): vscode.TreeItem {
    return item;
  }

  /** Keep completed conversations out of the way until the reviewer shows them. */
  getChildren(): ReviewItem[] {
    return this.sessions().flatMap((session) => session.store.threads.map((thread) => ({ session, thread })))
      .filter(({ thread }) => this.visibility.includes(thread))
      .sort((left, right) => Number(left.thread.resolved) - Number(right.thread.resolved))
      .map(({ session, thread }) => new ReviewItem(thread, session, thread.resolved ? undefined : session.activity?.(thread.id)));
  }

  /** Release the tree's event emitter. */
  dispose(): void {
    this.changes.dispose();
  }
}

/** Register native inline conversations, review navigation, and local Git diffs. */
export async function createReviewController(
  store: ReviewStore,
  context: vscode.ExtensionContext,
  resolveBase: (workspaceRoot: string) => Promise<string | undefined> = getHeadRevision,
  pullRequests?: ReviewSessionSource,
): Promise<vscode.Disposable> {
  const local: ReviewSession = {
    key: 'local', label: '', store,
    resolveBase: () => resolveBase(store.workspaceRoot),
    locate: (uri) => localLocation(uri, store.workspaceRoot),
    workingUri: (relativePath) => vscode.Uri.file(path.join(store.workspaceRoot, relativePath)),
    originalUri: (relativePath, revision) => baseUri(relativePath, revision),
  };
  const sessions = (): readonly ReviewSession[] => [local, ...(pullRequests?.sessions ?? [])];
  /** Find the session that owns a document. */
  function sessionFor(uri: vscode.Uri): { readonly session: ReviewSession; readonly location: SessionLocation } | undefined {
    for (const session of sessions()) {
      const location = session.locate(uri);
      if (location !== undefined) return { session, location };
    }
    return undefined;
  }
  /** Find a thread and its session; thread IDs are unique across sessions. */
  function findThread(id: string | undefined): { readonly session: ReviewSession; readonly thread: ReviewThread } | undefined {
    for (const session of sessions()) {
      const thread = session.store.threads.find((candidate) => candidate.id === id);
      if (thread !== undefined) return { session, thread };
    }
    return undefined;
  }
  const controller = vscode.comments.createCommentController(controllerId, 'Lokales Review');
  controller.options = { prompt: 'Antworten …', placeHolder: '/a fragen · /i umsetzen · /r zusammenfassen' };
  const authors: Record<ReviewMessage['author'], vscode.CommentAuthorInformation> = {
    human: { name: 'Du', iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'reviewer.svg') },
    claude: { name: 'Claude', iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'orb-avatar.svg') },
  };
  const bindings = new Map<string, ThreadBinding>();
  const renderedComments = new WeakMap<vscode.CommentThread, RenderedComments>();
  const visibility = new ReviewVisibility(context.workspaceState);
  await vscode.commands.executeCommand('setContext', resolvedVisibilityKey, visibility.showResolved);
  const tree = new ReviewTree(sessions, visibility);
  const view = vscode.window.createTreeView('diffGuide.threads', { treeDataProvider: tree, showCollapseAll: false });
  const disposables: vscode.Disposable[] = [controller, tree, view];
  const codeNavigation = await createCodeNavigation({
    get threads() { return sessions().flatMap((session) => session.store.threads); },
    workingUri: (anchor) => (sessions().find((session) => session.store.threads.some((thread) => thread.anchor === anchor)) ?? local).workingUri(anchor.path),
  });
  disposables.push(codeNavigation);
  const nativeDrafts = new Map<vscode.CommentThread, CodeAnchor>();
  const inlineSubmissions = new SubmissionGate<vscode.CommentThread>();
  let disposed = false;
  let syncPending = Promise.resolve();
  let reviewColumn: vscode.ViewColumn | undefined;
  let contextColumn: vscode.ViewColumn | undefined;
  let activeComposerTarget: ComposerRequest | undefined;
  let selectionGeneration = 0;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  const selectionDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffGuide.selectionBackground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    borderColor: new vscode.ThemeColor('diffGuide.selectionBorder'),
    overviewRulerColor: new vscode.ThemeColor('diffGuide.selectionBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  disposables.push(selectionDecoration);
  /** Persist either native or side-composer feedback through the same validation path. */
  async function commitFeedback(
    session: ReviewSession, submission: Pick<ComposerSubmission, 'anchor' | 'text' | 'intent' | 'threadId'>,
  ): Promise<ReviewThread> {
    const existing = session.store.threads.find((thread) => thread.id === submission.threadId);
    if (submission.threadId !== undefined && existing === undefined) {
      throw new Error('Diese Unterhaltung wurde nicht gefunden. Dein Entwurf bleibt gespeichert.');
    }
    if (existing?.resolved === true) {
      throw new Error('Öffne diese Unterhaltung wieder, bevor du weiteres Feedback sendest.');
    }
    const anchor = existing?.anchor ?? submission.anchor;
    if (anchor === undefined) {
      throw new Error('Der gespeicherte Codekontext fehlt. Wähle den Code erneut aus.');
    }
    const text = submission.text.trim()
      || (submission.intent === 'summarize' && existing !== undefined
        ? 'Fasse diese Unterhaltung und ihren aktuellen Stand zusammen.' : '');
    if (text.length === 0) throw new Error('Schreibe dein Feedback, bevor du es sendest.');
    const thread = await session.store.submit(anchor, text, submission.intent, submission.threadId);
    scheduleSync();
    return thread;
  }
  const composer = createComposer(context, async (submission) => {
    const thread = await commitFeedback(findThread(submission.threadId)?.session ?? local, submission);
    await syncPending;
    const native = bindings.get(thread.id)?.native;
    if (native !== undefined) native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }, async (request) => {
    if (request.anchor !== undefined) await codeNavigation.openAnchor(request.anchor);
  });
  disposables.push(composer);

  /** Cancel obsolete asynchronous captures when the human changes the composer target. */
  function cancelSelectionCapture(): void {
    selectionGeneration += 1;
    if (selectionTimer !== undefined) clearTimeout(selectionTimer);
    selectionTimer = undefined;
  }

  /** Keep the accepted code context visible independently of editor focus or caret position. */
  function refreshSelectionDecoration(): void {
    const target = activeComposerTarget;
    const anchor = target?.anchor;
    const session = findThread(target?.threadId)?.session ?? local;
    const uri = anchor === undefined ? undefined : anchorDocumentUri(session, anchor).toString();
    for (const editor of vscode.window.visibleTextEditors) {
      if (anchor === undefined || editor.document.uri.toString() !== uri) {
        editor.setDecorations(selectionDecoration, []);
        continue;
      }
      const binding = target?.threadId === undefined ? undefined : bindings.get(target.threadId);
      const location = locateCodeAnchor(editor.document.getText(), anchor);
      const range = binding?.native.uri.toString() === uri && binding.native.range !== undefined
        ? binding.native.range : location === undefined ? undefined : locationRange(editor.document, location);
      editor.setDecorations(selectionDecoration, range === undefined ? [] : [{
        range,
        hoverMessage: 'Fixierter Review-Kontext. Eine neue Codeauswahl wird in der Feedback-Ansicht angeboten.',
      }]);
    }
  }

  /** Use the same captured context for explicit commenting and automatic selection following. */
  async function feedbackRequest(editor: vscode.TextEditor, range: vscode.Range): Promise<ComposerRequest> {
    const anchor = await captureAnchor(local, editor.document.uri, range);
    return {
      id: `new:${hashDocumentText(JSON.stringify(anchor))}`,
      title: 'Feedback schreiben',
      path: anchor.path,
      code: capturedCodeContext(anchor).text,
      intent: 'ask',
      anchor,
    };
  }

  disposables.push(composer.onDidChangeTarget((request) => {
    cancelSelectionCapture();
    if (request !== undefined || !composer.isOpen()) activeComposerTarget = request;
    refreshSelectionDecoration();
  }));
  disposables.push(vscode.window.onDidChangeVisibleTextEditors(refreshSelectionDecoration));
  disposables.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    const selection = event.selections[0];
    if (!composer.isOpen() || selection === undefined || selection.isEmpty || event.selections.length !== 1
      || (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse && event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard)
      || local.locate(event.textEditor.document.uri) === undefined) return;
    cancelSelectionCapture();
    const generation = selectionGeneration;
    const editor = event.textEditor;
    const version = editor.document.version;
    const range = lineRange(editor.document, selection);
    selectionTimer = setTimeout(() => {
      selectionTimer = undefined;
      void (async () => {
        if (disposed || !composer.isOpen() || generation !== selectionGeneration || editor.document.version !== version) return;
        const request = await feedbackRequest(editor, range);
        if (disposed || !composer.isOpen() || generation !== selectionGeneration || editor.document.version !== version) return;
        await composer.followSelection(request);
      })().catch(reportError);
    }, 140);
  }));

  /** Surface failures without discarding the user's existing review text. */
  function reportError(error: unknown): void {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Das Review konnte nicht aktualisiert werden.');
  }

  /** Restore a thread on confirmed current code, or on its immutable captured excerpt. */
  async function openAnchorDocument(session: ReviewSession, thread: ReviewThread): Promise<LocatedDocument> {
    try {
      const uri = anchorDocumentUri(session, thread.anchor);
      if (uri.scheme === 'file') {
        await vscode.workspace.fs.stat(uri);
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const location = locateCodeAnchor(document.getText(), thread.anchor);
      if (location !== undefined) {
        return { document, range: locationRange(document, location), captured: false };
      }
    } catch {
      // A missing source or Git object cannot justify attaching the thread to another line.
    }
    const document = await vscode.workspace.openTextDocument(contextUri(thread));
    return { document, range: locationRange(document, capturedCodeContext(thread.anchor)), captured: true };
  }

  /** Copy durable status into the native comment controls. */
  function updateNative(thread: ReviewThread, native: vscode.CommentThread): void {
    const previous = renderedComments.get(native);
    if (previous?.messages !== thread.messages) {
      const reusable = new Map(previous?.messages.map((message, index) => [message, previous.comments[index]]));
      const comments = thread.messages.map((message, index) => {
        const existing = reusable.get(message);
        if (existing !== undefined) return existing;
        const comment = nativeComment(message, index === 0, authors[message.author], codeNavigation.markdown(thread, message));
        codeNavigation.bindComment(thread, message, comment);
        return comment;
      });
      native.comments = comments;
      renderedComments.set(native, { messages: thread.messages, comments });
    }
    const owner = findThread(thread.id)?.session;
    const contextValue = owner === undefined ? (thread.resolved ? 'diffGuide.resolved' : 'diffGuide.open') : threadContext(owner, thread);
    const state = thread.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    const canReply = thread.resolved ? false : authors.human;
    if (native.contextValue !== contextValue) native.contextValue = contextValue;
    if (native.state !== state) native.state = state;
    if (native.canReply !== canReply) native.canReply = canReply;
    const contextLabel = native.uri.scheme === contextScheme ? ' · Gespeicherter Kontext' : thread.outdated ? ' · Kontext geändert' : '';
    const activity = thread.resolved ? undefined : owner?.activity?.(thread.id);
    const published = owner === undefined ? '' : publicationLabel(owner, thread);
    const label = `${intentLabels[thread.intent]} · ${thread.resolved ? 'Erledigt' : activity ?? statusLabels[thread.status]}${published}${contextLabel}`;
    if (native.label !== label) native.label = label;
  }

  /** Attach a native comment control and remember its current document boundaries. */
  function bindThread(thread: ReviewThread, native: vscode.CommentThread, document: vscode.TextDocument): void {
    const range = native.range ?? new vscode.Range(0, 0, 0, 0);
    bindings.set(thread.id, {
      native,
      startOffset: document.offsetAt(range.start),
      endOffset: document.offsetAt(range.end),
      documentVersion: document.version,
      currentHash: documentHash(document),
    });
    updateNative(thread, native);
  }

  /** Restore only missing controls so agent replies never move live editor anchors. */
  async function synchronize(): Promise<void> {
    if (disposed) {
      return;
    }
    tree.refresh();
    const all = sessions().flatMap((session) => session.store.threads.map((thread) => ({ session, thread })));
    const queued = sessions().reduce((count, session) => count + session.store.pendingEvents.length, 0);
    view.title = queued === 0 ? 'Review' : `Review · ${queued} wartend`;
    const completed = all.filter(({ thread }) => thread.resolved).length;
    view.description = completed === 0 ? '' : `${completed} erledigt${visibility.showResolved ? '' : ' ausgeblendet'}`;
    view.message = completed > 0 && completed === all.length && !visibility.showResolved
      ? 'Alle Kommentare erledigt. Mit „Erledigte anzeigen“ kannst du sie wieder öffnen.' : '';
    for (const { session, thread } of all) {
      const store = session.store;
      const binding = bindings.get(thread.id);
      if (!visibility.includes(thread)) {
        binding?.native.dispose();
        bindings.delete(thread.id);
        if (activeComposerTarget?.threadId === thread.id && !composer.isOpen()) activeComposerTarget = undefined;
        continue;
      }
      if (binding !== undefined) {
        updateNative(thread, binding.native);
        continue;
      }
      try {
        const located = await openAnchorDocument(session, thread);
        const current = store.threads.find((candidate) => candidate.id === thread.id);
        if (disposed || bindings.has(thread.id) || current === undefined || !visibility.includes(current)) {
          continue;
        }
        const native = controller.createCommentThread(located.document.uri, located.range, []);
        bindThread(current, native, located.document);
        if (!current.outdated && (located.captured || documentHash(located.document) !== current.anchor.documentHash)) {
          await store.setOutdated(current.id, true);
        }
      } catch {
        if (!thread.outdated) {
          await store.setOutdated(thread.id, true);
        }
      }
    }
    refreshSelectionDecoration();
  }

  /** Show Claude's current step on open threads without restoring documents. */
  function refreshActivity(): void {
    if (disposed) return;
    for (const [id, binding] of bindings) {
      const found = findThread(id);
      if (found !== undefined) updateNative(found.thread, binding.native);
    }
    tree.refresh();
  }

  /** Serialize refreshes because restoring native documents is asynchronous. */
  function scheduleSync(): void {
    syncPending = syncPending.then(synchronize).catch(reportError);
  }

  /** Persist the review filter and update both editor and sidebar together. */
  async function showResolved(visible: boolean): Promise<void> {
    await visibility.setShowResolved(visible);
    await vscode.commands.executeCommand('setContext', resolvedVisibilityKey, visibility.showResolved);
    scheduleSync();
    await syncPending;
  }

  /** Reconfirm an anchor when edits occurred outside the known live document history. */
  function reconcileBinding(id: string, binding: ThreadBinding, document: vscode.TextDocument): void {
    const thread = findThread(id)?.thread;
    const location = thread === undefined ? undefined : locateCodeAnchor(document.getText(), thread.anchor);
    if (location === undefined) {
      binding.native.dispose();
      bindings.delete(id);
      scheduleSync();
    } else {
      const range = locationRange(document, location);
      binding.native.range = range;
      binding.startOffset = document.offsetAt(range.start);
      binding.endOffset = document.offsetAt(range.end);
      binding.documentVersion = document.version;
      binding.currentHash = documentHash(document);
    }
    if (thread !== undefined && !thread.outdated) {
      void findThread(id)?.session.store.setOutdated(id, true).catch(reportError);
    }
  }

  /** Mark contexts as uncertain when their Git base has changed. */
  async function validateRevisions(): Promise<void> {
    for (const session of sessions()) {
      const revision = await session.resolveBase() ?? 'unborn';
      for (const thread of session.store.threads) {
        if (!thread.outdated && thread.anchor.baseRevision !== revision) {
          await session.store.setOutdated(thread.id, true);
        }
      }
    }
  }

  /** Capture an immutable code snapshot rather than trusting mutable line numbers. */
  async function captureAnchor(session: ReviewSession, uri: vscode.Uri, selection: vscode.Range): Promise<CodeAnchor> {
    const location = session.locate(uri);
    if (location === undefined) {
      throw new Error('Wähle eine Datei in diesem Arbeitsbereich, um Feedback hinzuzufügen.');
    }
    const relativePath = location.path;
    const document = await vscode.workspace.openTextDocument(uri);
    const range = lineRange(document, selection);
    const selectedText = document.getText(range);
    const contextBefore = document.getText(new vscode.Range(Math.max(0, range.start.line - 3), 0, range.start.line, 0));
    const contextAfter = range.end.line + 1 >= document.lineCount ? '' : document.getText(new vscode.Range(range.end.line + 1, 0, Math.min(document.lineCount - 1, range.end.line + 3), Number.MAX_SAFE_INTEGER));
    const hash = documentHash(document);
    const revision = location.revision ?? await session.resolveBase() ?? 'unborn';
    return {
      path: relativePath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      selectedText,
      contextBefore,
      contextAfter,
      documentHash: hash,
      side: location.original ? 'original' : 'working',
      baseRevision: revision,
    };
  }

  /** Find a persisted thread from either a native control or a sidebar action. */
  function threadId(argument: unknown): string | undefined {
    if (typeof argument === 'string') {
      return findThread(argument) === undefined ? undefined : argument;
    }
    if (argument instanceof ReviewItem) {
      return argument.threadId;
    }
    for (const [id, binding] of bindings) {
      if (binding.native === argument) {
        return id;
      }
    }
    return undefined;
  }

  /** Find an existing comparison so navigation keeps the user's review editor group. */
  function existingDiffGroup(original: vscode.Uri, modified: vscode.Uri): vscode.TabGroup | undefined {
    return vscode.window.tabGroups.all.find((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff
      && tab.input.original.toString() === original.toString()
      && tab.input.modified.toString() === modified.toString()));
  }

  /** Reuse the review comparison instead of replacing it with a standalone file. */
  async function openReviewDiff(relativePath: string, revision: string): Promise<void> {
    const original = baseUri(relativePath, revision);
    const current = local.workingUri(relativePath);
    let modified = current;
    try {
      await vscode.workspace.fs.stat(current);
    } catch {
      modified = baseUri(relativePath, revision, true);
    }
    const existing = existingDiffGroup(original, modified);
    const remembered = vscode.window.tabGroups.all.some((group) => group.viewColumn === reviewColumn) ? reviewColumn : undefined;
    await vscode.commands.executeCommand('vscode.diff', original, modified, `${relativePath} · Lokales Review`, {
      preview: true,
      viewColumn: existing?.viewColumn ?? remembered ?? vscode.ViewColumn.Active,
    });
    reviewColumn = existingDiffGroup(original, modified)?.viewColumn;
  }

  /** Keep an immutable context excerpt beside the full code comparison when needed. */
  async function revealBesideDiff(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
    const remembered = contextColumn !== reviewColumn
      && vscode.window.tabGroups.all.some((group) => group.viewColumn === contextColumn) ? contextColumn : undefined;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: remembered ?? vscode.ViewColumn.Beside,
      preview: true,
      selection: range,
    });
    contextColumn = editor.viewColumn;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Reveal the conversation while retaining its comparison and confirmed code context. */
  async function reveal(argument: unknown): Promise<void> {
    const id = threadId(argument);
    const owner = findThread(id);
    if (owner === undefined) {
      return;
    }
    const { session } = owner;
    const store = session.store;
    let thread: ReviewThread | undefined = owner.thread;
    if (!visibility.includes(thread)) await showResolved(true);
    let binding = bindings.get(thread.id);
    if (binding !== undefined && binding.native.uri.scheme !== contextScheme) {
      try {
        await vscode.workspace.fs.stat(binding.native.uri);
      } catch {
        binding.native.dispose();
        bindings.delete(thread.id);
        binding = undefined;
      }
    }
    thread = store.threads.find((candidate) => candidate.id === id);
    if (disposed || thread === undefined || !visibility.includes(thread)) return;
    binding = bindings.get(thread.id);
    if (binding === undefined) {
      const located = await openAnchorDocument(session, thread);
      thread = store.threads.find((candidate) => candidate.id === id);
      if (disposed || thread === undefined || !visibility.includes(thread)) return;
      if (!bindings.has(thread.id)) {
        const native = controller.createCommentThread(located.document.uri, located.range, []);
        bindThread(thread, native, located.document);
      }
      binding = bindings.get(thread.id);
      if (located.captured && !thread.outdated) {
        await store.setOutdated(thread.id, true);
      }
    }
    if (binding === undefined || binding.native.range === undefined) {
      throw new Error('Die Position dieses Review-Kommentars konnte nicht geöffnet werden.');
    }
    const range = binding.native.range;
    const document = await vscode.workspace.openTextDocument(binding.native.uri);
    const current = store.threads.find((candidate) => candidate.id === id);
    if (disposed || current === undefined || !visibility.includes(current) || bindings.get(current.id) !== binding) return;
    binding.native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    if (session === local) await openReviewDiff(thread.anchor.path, thread.anchor.baseRevision);
    const revealed = store.threads.find((candidate) => candidate.id === id);
    if (disposed || revealed === undefined || !visibility.includes(revealed) || bindings.get(revealed.id) !== binding) return;
    const visible = vscode.window.visibleTextEditors.filter((candidate) => candidate.document.uri.toString() === document.uri.toString());
    const editor = visible.find((candidate) => candidate.viewColumn === reviewColumn)
      ?? visible.find((candidate) => candidate === vscode.window.activeTextEditor) ?? visible[0];
    if (editor === undefined || document.uri.scheme === contextScheme) {
      await revealBesideDiff(document, range);
    } else {
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /** Open one local file against its immutable review base, including new files. */
  async function openChanges(argument: unknown): Promise<void> {
    await validateRevisions();
    const base = await local.resolveBase();
    let relativePath = argument instanceof vscode.Uri ? local.locate(argument)?.path : undefined;
    if (relativePath === undefined) {
      const files = await listChangedFiles(store.workspaceRoot, base);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('Es gibt keine lokalen Änderungen zum Prüfen.');
        return;
      }
      relativePath = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, { title: 'Lokale Änderungen prüfen', placeHolder: 'Wähle eine geänderte Datei' });
    }
    if (relativePath === undefined) {
      return;
    }
    await openReviewDiff(relativePath, base ?? 'unborn');
  }

  disposables.push(vscode.workspace.registerTextDocumentContentProvider(baseScheme, {
    provideTextDocumentContent: async (uri) => {
      const reference = baseReference(uri);
      if (reference === undefined) {
        throw new Error('Die gespeicherte Codeversion ist ungültig.');
      }
      return reference.emptyWorking ? '' : await readGitBase(store.workspaceRoot, reference.relativePath, reference.revision);
    },
  }));
  disposables.push(vscode.workspace.registerTextDocumentContentProvider(contextScheme, {
    provideTextDocumentContent: (uri) => {
      const id = new URLSearchParams(uri.query).get('thread');
      const thread = findThread(id ?? undefined)?.thread;
      if (thread === undefined) {
        throw new Error('Der gespeicherte Review-Kontext wurde nicht gefunden.');
      }
      return capturedCodeContext(thread.anchor).text;
    },
  }));
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) => sessionFor(document.uri) === undefined
      ? [] : [new vscode.Range(0, 0, document.lineCount - 1, 0)],
  };
  const register = (id: string, callback: (argument: unknown) => Promise<void>): void => {
    disposables.push(vscode.commands.registerCommand(`diffGuide.${id}`, (argument: unknown) => callback(argument).catch(reportError)));
  };
  register('addComment', async () => {
    cancelSelectionCapture();
    const generation = selectionGeneration;
    const editor = vscode.window.activeTextEditor;
    const owner = editor === undefined ? undefined : sessionFor(editor.document.uri);
    if (editor === undefined || owner === undefined) {
      void vscode.window.showInformationMessage('Markiere Code in diesem Arbeitsbereich, um einen Review-Kommentar hinzuzufügen.');
      return;
    }
    const range = lineRange(editor.document, editor.selection);
    const request = owner.session === local ? await feedbackRequest(editor, range) : undefined;
    const anchor = request?.anchor ?? await captureAnchor(owner.session, editor.document.uri, range);
    if (disposed || generation !== selectionGeneration) return;
    const draft = controller.createCommentThread(editor.document.uri, range, []);
    draft.contextValue = 'diffGuide.draft';
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    draft.canReply = authors.human;
    draft.label = 'Neuer Kommentar';
    nativeDrafts.set(draft, anchor);
    if (request !== undefined) activeComposerTarget = request;
    refreshSelectionDecoration();
  });
  register('openComposer', async () => {
    cancelSelectionCapture();
    const generation = selectionGeneration;
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined && local.locate(editor.document.uri) === undefined && sessionFor(editor.document.uri) !== undefined) {
      throw new Error('The side composer is not available for pull requests yet. Comment inline instead.');
    }
    if (editor === undefined || local.locate(editor.document.uri) === undefined) {
      throw new Error('Markiere Code in diesem Arbeitsbereich, um die Seitenansicht zu öffnen.');
    }
    const request = await feedbackRequest(editor, lineRange(editor.document, editor.selection));
    if (disposed || generation !== selectionGeneration) return;
    await composer.open(request);
  });
  disposables.push(vscode.commands.registerCommand('diffGuide.submitInline', (argument: unknown) => {
    const reply = normalizeInlineReply(argument);
    if (reply === undefined) {
      const error = new Error('Dieser Kommentar kann nicht abgesendet werden. Dein Text bleibt erhalten.');
      reportError(error);
      return Promise.reject(error);
    }
    return inlineSubmissions.run(reply.thread, async () => {
      try {
        const id = threadId(reply.thread);
        const owner = findThread(id);
        const existing = owner?.thread;
        const session = owner?.session ?? sessionFor(reply.thread.uri)?.session;
        if (session === undefined) {
          throw new Error('Dieser Kommentar gehört nicht zu diesem Arbeitsbereich. Dein Text bleibt erhalten.');
        }
        const store = session.store;
        const parsed = parseComposerInput(reply.text, existing?.intent ?? 'ask', true);
        const document = await vscode.workspace.openTextDocument(reply.thread.uri);
        const draftAnchor = nativeDrafts.get(reply.thread);
        const anchor = existing?.anchor ?? draftAnchor ?? await captureAnchor(session, reply.thread.uri, reply.thread.range ?? new vscode.Range(0, 0, 0, 0));
        const thread = await commitFeedback(session, {
          anchor, text: parsed.text, intent: parsed.intent, ...(id === undefined ? {} : { threadId: id }),
        });
        try {
          const located = draftAnchor === undefined ? undefined : await openAnchorDocument(session, thread);
          const native = located?.captured === true
            ? controller.createCommentThread(located.document.uri, located.range, []) : reply.thread;
          if (located !== undefined) native.range = located.range;
          const restored = bindings.get(thread.id);
          if (restored !== undefined && restored.native !== native) restored.native.dispose();
          bindThread(thread, native, located?.document ?? document);
          nativeDrafts.delete(reply.thread);
          if (native !== reply.thread) reply.thread.dispose();
          native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
          activeComposerTarget = {
            id: `thread:${thread.id}`, title: 'Review', path: anchor.path,
            code: capturedCodeContext(anchor).text, intent: parsed.intent, threadId: thread.id, anchor,
          };
          refreshSelectionDecoration();
          if (draftAnchor !== undefined && (located?.captured === true || documentHash(located?.document ?? document) !== anchor.documentHash)) {
            await store.setOutdated(thread.id, true);
          }
          if (located?.captured === true) await revealBesideDiff(located.document, located.range);
        } catch (error: unknown) {
          reportError(error);
        }
        scheduleSync();
      } catch (error: unknown) {
        reportError(error);
        throw error;
      }
    });
  }));
  register('cancelDraft', async (argument) => {
    const candidate = (normalizeInlineReply(argument) ?? normalizeInlineReply({ thread: argument, text: '' }))?.thread;
    if (candidate === undefined || candidate.comments.length !== 0
      || sessionFor(candidate.uri) === undefined
      || threadId(candidate) !== undefined || inlineSubmissions.isPending(candidate)) return;
    candidate.dispose();
    nativeDrafts.delete(candidate);
    activeComposerTarget = undefined;
    refreshSelectionDecoration();
  });
  register('resumeDraft', async () => {
    cancelSelectionCapture();
    await composer.resume();
  });
  register('composeReply', async (argument) => {
    cancelSelectionCapture();
    const thread = findThread(threadId(argument))?.thread;
    if (thread === undefined) throw new Error('Öffne eine Review-Unterhaltung, um zu antworten.');
    if (thread.resolved) throw new Error('Öffne diese Unterhaltung zuerst wieder.');
    await composer.open({
      id: `thread:${thread.id}`,
      title: 'Im Review antworten',
      path: thread.anchor.path,
      code: capturedCodeContext(thread.anchor).text,
      intent: thread.intent,
      threadId: thread.id,
      anchor: thread.anchor,
    });
  });
  for (const command of ['publishThread', 'openPublishedThread']) {
    register(command, async (argument) => {
      const found = findThread(threadId(argument));
      await found?.session.publish?.(found.thread.id);
    });
  }
  register('openChanges', openChanges);
  register('revealThread', reveal);
  register('showResolved', async () => { await showResolved(true); });
  register('hideResolved', async () => { await showResolved(false); });
  for (const [command, resolved] of [['resolve', true], ['reopen', false]] as const) {
    register(command, async (argument) => {
      const id = threadId(argument);
      if (id !== undefined) {
        const binding = bindings.get(id);
        if (resolved && binding !== undefined && inlineSubmissions.isPending(binding.native)) {
          throw new Error('Dein Kommentar wird noch gespeichert. Markiere die Unterhaltung danach als erledigt.');
        }
        await findThread(id)?.session.store.resolve(id, resolved);
        await syncPending;
      }
    });
  }
  const storeSubscriptions = new Map<ReviewStore, vscode.Disposable>();
  /** Follow every session's store, including PR sessions added later. */
  function subscribeStores(): void {
    const current = new Set(sessions().map((session) => session.store));
    for (const [candidate, subscription] of storeSubscriptions) {
      if (!current.has(candidate)) { subscription.dispose(); storeSubscriptions.delete(candidate); }
    }
    for (const candidate of current) {
      if (!storeSubscriptions.has(candidate)) storeSubscriptions.set(candidate, candidate.onChange(scheduleSync));
    }
  }
  subscribeStores();
  disposables.push({ dispose: () => { for (const subscription of storeSubscriptions.values()) subscription.dispose(); } });
  if (pullRequests !== undefined) {
    disposables.push(pullRequests.onDidChange(() => {
      subscribeStores();
      scheduleSync();
      void validateRevisions().catch(reportError);
    }));
    if (pullRequests.onDidChangeActivity !== undefined) disposables.push(pullRequests.onDidChangeActivity(refreshActivity));
  }
  disposables.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void validateRevisions().catch(reportError);
    }
  }));
  disposables.push(vscode.workspace.onDidOpenTextDocument((document) => {
    for (const [id, binding] of bindings) {
      if (binding.native.uri.toString() !== document.uri.toString()) {
        continue;
      }
      const hash = documentHash(document);
      if (hash !== binding.currentHash) {
        reconcileBinding(id, binding, document);
        continue;
      }
      const range = document.validateRange(binding.native.range ?? new vscode.Range(0, 0, 0, 0));
      binding.startOffset = document.offsetAt(range.start);
      binding.endOffset = document.offsetAt(range.end);
      binding.documentVersion = document.version;
      binding.currentHash = hash;
      binding.native.range = range;
    }
  }));
  disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0) {
      return;
    }
    const changes = [...event.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset);
    const currentHash = documentHash(event.document);
    for (const [id, binding] of bindings) {
      if (binding.native.uri.toString() !== event.document.uri.toString()) {
        continue;
      }
      if (event.document.version !== binding.documentVersion + 1) {
        reconcileBinding(id, binding, event.document);
        continue;
      }
      let outdated = false;
      for (const change of changes) {
        const end = change.rangeOffset + change.rangeLength;
        const overlaps = change.rangeLength === 0
          ? change.rangeOffset >= binding.startOffset && change.rangeOffset <= binding.endOffset
          : binding.startOffset === binding.endOffset
            ? change.rangeOffset <= binding.startOffset && end >= binding.startOffset
            : change.rangeOffset < binding.endOffset && end > binding.startOffset;
        outdated ||= overlaps;
        binding.startOffset = mapOffset(binding.startOffset, change, false);
        binding.endOffset = mapOffset(binding.endOffset, change, true);
      }
      binding.startOffset = Math.max(0, binding.startOffset);
      binding.endOffset = Math.max(binding.startOffset, binding.endOffset);
      binding.native.range = new vscode.Range(event.document.positionAt(binding.startOffset), event.document.positionAt(binding.endOffset));
      binding.documentVersion = event.document.version;
      binding.currentHash = currentHash;
      const owner = findThread(id);
      if (outdated && owner !== undefined && !owner.thread.outdated) {
        void owner.session.store.setOutdated(id, true).catch(reportError);
      }
    }
  }));

  await synchronize();
  await validateRevisions().catch(reportError);
  const disposable = new vscode.Disposable(() => {
    disposed = true;
    cancelSelectionCapture();
    nativeDrafts.forEach((_anchor, draft) => draft.dispose());
    nativeDrafts.clear();
    for (const item of disposables.reverse()) {
      item.dispose();
    }
    bindings.clear();
  });
  context.subscriptions.push(disposable);
  return disposable;
}
