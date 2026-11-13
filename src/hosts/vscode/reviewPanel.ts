import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type Reviewer, reviewers as allReviewers } from '../../core/contracts.js';
import { type ChangeRequestConversation, type CommentKind, type HideReason, type MergeMessage, type MergeMethod, type ReactionContent, reactionContents, type ReviewEvent } from '../../core/forge.js';
import { recheckRequest } from '../../core/review.js';
import { overviewHtml } from '../../page/html.js';
import { icons } from '../../page/icons.js';
import { type CommentIntent, commentIntents, commentKinds, type DiffSelection, editActions, type ExtensionMessage, hideReasons, isLine, isNameList, isOid, isOptionalText, isText, maximumReviewLength, mergeMethods, type OverviewActions, type OverviewReveal, type OverviewState, parseClaudeChoice, parseRange, type PickedSuggestion, type PickTarget, pickTargets, pullRequestActions, reviewEvents } from '../../page/protocol.js';
import { pollWhileFocused } from './autoSync.js';
import { workingIcon } from './claudeStatus.js';
import { closedIcon, mergedIcon, pullRequestIcon } from './pullRequestItems.js';

const revealMessage = (reveal: OverviewReveal | undefined): ExtensionMessage => reveal === undefined ? {}
  : 'path' in reveal ? { reveal: reveal.path } : 'step' in reveal ? { revealStep: reveal.step } : 'thread' in reveal ? { revealThread: reveal.thread } : { revealGroup: reveal.group };

/** Whether a review page is open. */
export function isPageOpen(key: string): boolean {
  return panels.has(key);
}

/** Show a review page if it is open; a reveal with `reload` reads the files again first, since the file may not be on the page yet. */
export function revealOpenPage(key: string, reveal?: OverviewReveal): boolean {
  const page = panels.get(key);
  if (page === undefined) return false;
  page.panel.reveal();
  if (reveal !== undefined && 'path' in reveal && reveal.reload === true) page.sendFiles(reveal);
  else if (reveal !== undefined) void page.panel.webview.postMessage(revealMessage(reveal)).then(undefined, () => undefined);
  return true;
}

/**
 * Show a review page, reusing it when already open, and redraw it whenever `onDidChange` fires.
 * `onDidChangeFiles` reads the files again, for a page whose files change without a commit.
 */
/** The tab's icon, the PR's sidebar icon; none on the local review page. */
function tabIcon(state: OverviewState): vscode.ThemeIcon | undefined {
  if (state.claude.running || state.analysis.running || state.review?.running === true || state.threads.some((thread) => thread.working !== undefined)) return workingIcon;
  const details = state.details;
  if (details === undefined) return undefined;
  if (details.merged) return mergedIcon;
  if (!details.open) return closedIcon;
  const states = details.reviewers.map((reviewer) => reviewer.state);
  const review = states.includes('changes') ? 'changes' : states.includes('approved') ? 'approved' : states.includes('commented') ? 'commented' : undefined;
  const awaitingReview = details.viewerIsAuthor && details.reviewers.some((reviewer) => reviewer.state === 'requested' || reviewer.rerequested === true);
  return pullRequestIcon(details.draft, review, awaitingReview);
}

const colorValue = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %]+\))$/;

/** Theme colors the page read from its CSS variables, keyed by color id; invalid entries are dropped. */
function themeColors(value: unknown): Map<string, string> {
  const colors = new Map<string, string>();
  if (typeof value !== 'object' || value === null) return colors;
  for (const [id, color] of Object.entries(value).slice(0, 20)) if (/^[a-zA-Z.]{1,60}$/.test(id) && typeof color === 'string' && colorValue.test(color)) colors.set(id, color);
  return colors;
}

/**
 * The icon drawn in `color` as an SVG file; content-named, so a file is never rewritten with other content.
 * In a browser it goes under `extensionUri`, since a proxied server such as SageMaker's may serve only extension files.
 */
async function coloredIcon(id: string, color: string, extensionUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const name = id.replace(/^diffguide-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const svg = (icons as Record<string, string>)[name];
  if (svg === undefined) return undefined;
  const text = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ').replaceAll('currentColor', color);
  const folder = vscode.env.uiKind === vscode.UIKind.Web ? join(extensionUri.fsPath, 'dist', 'tab-icons') : join(tmpdir(), 'diffguide-tab-icons');
  const file = join(folder, name + '-' + createHash('sha256').update(text).digest('hex').slice(0, 12) + '.svg');
  await mkdir(folder, { recursive: true });
  await writeFile(file, text);
  return vscode.Uri.file(file);
}

export async function showPullRequestOverview(
  key: string, read: () => Promise<OverviewState>, onDidChange: vscode.Event<unknown>, actions: OverviewActions, extensionUri: vscode.Uri, revealAt?: OverviewReveal,
  onDidChangeFiles?: vscode.Event<unknown>,
  /** An open page whose tab this page takes over, such as the local review of the checkout a PR is open on. */
  adopt?: string,
): Promise<void> {
  if (revealOpenPage(key, revealAt)) return;
  let reveal = revealAt;
  let state = await read();
  const restoredPanel = restored.get(key);
  restored.delete(key);
  const adopted = restoredPanel ?? (adopt === undefined ? undefined : panels.get(adopt)?.detach());
  if (adopted !== undefined) adopted.title = state.title;
  const panel = adopted ?? vscode.window.createWebviewPanel(reviewPageType, state.title, vscode.ViewColumn.Active,
    { localResourceRoots: [], ...pageOptions(extensionUri), retainContextWhenHidden: true, enableFindWidget: true });
  if (restoredPanel !== undefined) panel.webview.options = pageOptions(extensionUri);
  const pageKey = key;
  const resource = (...parts: string[]): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
  panel.webview.html = overviewHtml(state, resource('dist', 'overview.js'), resource('dist', 'pdf.js'));
  let colors = new Map<string, string>();
  let iconWrites = 0;
  /** Webview tabs show a theme icon's shape but drop its color, so once the page sends the theme's colors the tab gets an SVG drawn in them. */
  const updateTabIcon = (): void => {
    const icon = tabIcon(state);
    if (icon === undefined) return;
    const write = ++iconWrites;
    const color = icon.color instanceof vscode.ThemeColor ? colors.get(icon.color.id) : undefined;
    // The API types allow only image files, but VS Code also shows a theme icon in a webview tab.
    if (color === undefined) { (panel as { iconPath?: unknown }).iconPath = icon; return; }
    void coloredIcon(icon.id, color, extensionUri).then((uri) => { if (uri !== undefined && write === iconWrites) panel.iconPath = uri; }, () => undefined);
  };
  updateTabIcon();
  const post = (message: ExtensionMessage): void => { void panel.webview.postMessage(message).then(undefined, () => undefined); };
  const sendFiles = (select?: DiffSelection): void => {
    void actions.readFiles(select).then(({ files, selection, atHead, icons, repositoryFiles }) => {
      post({ files, selection, atHead, ...icons === undefined ? {} : { icons }, ...repositoryFiles === undefined ? {} : { repositoryFiles }, ...revealMessage(reveal) });
      reveal = undefined;
    }, (error: unknown) => {
      post({ filesError: error instanceof Error ? error.message : String(error) });
    });
  };
  panels.set(key, { panel, sendFiles: (next) => { reveal = next; sendFiles(); }, detach: () => { release(); disposed.dispose(); return panel; } });
  const conversation = (): ChangeRequestConversation | undefined => state.conversation;
  /** A comment on this page the viewer may change in the way `may` names, found in the conversation or a GitHub thread. */
  const findComment = (id: unknown, may: 'canEdit' | 'canDelete' | 'canHide' | 'canReact'): boolean => typeof id === 'string'
    && ((conversation()?.timeline ?? []).some((item) => item.kind !== 'commit' && item.kind !== 'event' && item.id === id && item[may])
      || (state.github ?? []).some((thread) => thread.messages.some((entry) => entry.id === id && entry[may])));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by each read and each mark write; a read that is no longer the latest may predate a write, so it is dropped. */
  let generation = 0;
  /** Mark writes still running. A read during one would undo the page's own ticks, so the last write to finish redraws. */
  let writing = 0;
  const redraw = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (writing > 0) return;
      const started = ++generation;
      void read().then((next) => {
        if (started !== generation) return;
        const claudeStopped = state.claude.running && !next.claude.running;
        state = next;
        panel.title = next.title;
        updateTabIcon();
        post({ state: next });
        if (claudeStopped) sendFiles();
      }, () => undefined);
    }, 150);
  };
  const marking = async (write: Promise<void>): Promise<void> => {
    generation++;
    writing++;
    try { await write; } finally { writing--; redraw(); }
  };
  let busy = false;
  const subscriptions = [
    onDidChange(redraw),
    panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      const { action, id, ids, paths, event, body, method, what, values, teams, draft, path, viewed, side, startLine, endLine, text, intent, resolved, archived, pending, form, peek, line, column, extension, message, option,
        range, whitespace, kind, hide, reason, content, on, login, run, headline, picked, branch, oid, title, deleteBranch, key, link, command, reviewers: reviewersPicked } = value as Record<string, unknown>;
      const formKey = typeof form === 'string' && form.length <= 200 ? form : undefined;
      try {
        if (action === 'ready') { post({ pageKey }); sendFiles(); }
        else if (action === 'theme-colors') { colors = themeColors((value as Record<string, unknown>)['colors']); updateTabIcon(); }
        else if (action === 'comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && commentIntents.includes(intent)) {
          await actions.comment({ path, side, startLine, endLine, text: text.trim(), intent: intent as CommentIntent });
          post({ done: formKey });
        } else if (action === 'file-comment' && typeof path === 'string' && isText(text) && commentIntents.includes(intent)) {
          await actions.commentOnFile(path, text.trim(), intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'github-comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && typeof pending === 'boolean') {
          await actions.commentOnGitHub({ path, side, startLine, endLine, text: text.trim() }, pending);
          post({ done: formKey });
        } else if (action === 'github-file-comment' && typeof path === 'string' && isText(text) && typeof pending === 'boolean') {
          await actions.commentOnGitHubFile(path, text.trim(), pending);
          post({ done: formKey });
        } else if (action === 'reply' && typeof id === 'string' && commentIntents.includes(intent) && (isText(text) || (intent === 'implement' && isOptionalText(text)))) {
          await actions.reply(id, (text ?? '').trim(), intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'resolve' && typeof id === 'string' && typeof resolved === 'boolean') await actions.resolve(id, resolved);
        else if (action === 'archive' && typeof id === 'string' && typeof archived === 'boolean' && state.threads.some((thread) => thread.id === id)) await actions.archive(id, archived);
        else if (action === 'withdraw' && typeof id === 'string' && state.threads.some((thread) => thread.id === id && thread.scope !== 'pullRequest')) {
          const { text, anchor, received, threadRemoved } = await actions.withdraw(id);
          post({
            restored: { thread: id, text, threadRemoved, path: anchor.path, side: anchor.side === 'original' ? 'old' : 'new', startLine: anchor.startLine, endLine: anchor.endLine, ...(anchor.scope === 'file' ? { scope: 'file' as const } : {}) },
            notice: { text: received ? 'Claude had already read this comment and may have acted on it.' : 'Took the comment back before Claude read it.' },
          });
        }
        else if (action === 'publish' && typeof id === 'string') await actions.publish(id);
        else if (action === 'github-reply' && typeof id === 'string' && isText(text) && state.github?.some((thread) => thread.id === id)) {
          await actions.replyOnGitHub(id, text.trim());
          post({ done: formKey });
        } else if (action === 'github-publish' && typeof id === 'string' && isText(text) && typeof pending === 'boolean') {
          await actions.postToGitHub(id, text.trim(), pending);
          post({ done: formKey });
        } else if (action === 'github-ask' && typeof id === 'string' && isOptionalText(text) && commentIntents.includes(intent) && state.github?.some((thread) => thread.id === id)) {
          await actions.askAboutGitHub(id, text ?? '', intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'comment-ask' && typeof id === 'string' && isOptionalText(text) && commentIntents.includes(intent)
          && (conversation()?.timeline ?? []).some((item) => (item.kind === 'comment' || item.kind === 'review') && item.id === id && item.body.trim() !== '')) {
          await actions.askAboutComment(id, text ?? '', intent as CommentIntent);
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
          const at = typeof peek === 'string' ? { peek } : { path: path as string };
          const found = await actions.findDefinition(at, line, column as number);
          if (found !== undefined) post({ definition: found });
          else {
            const missing = await actions.missingLanguage(at).catch(() => undefined);
            post({ notice: missing === undefined ? { text: 'No definition found here.' } : { text: `No definition found. VS Code has no language support for .${missing} files.`, extension: missing } });
          }
        } else if (action === 'probe' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0
          && typeof id === 'string' && id.length <= 400) {
          const found = await actions.hasDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number).catch(() => false);
          post({ probe: { id, found } });
        } else if (action === 'open-definition' && typeof peek === 'string') await actions.openDefinition(peek);
        else if ((action === 'apply-suggestion' || action === 'publish-suggestion') && typeof id === 'string' && state.threads.some((thread) => thread.id === id)
          && Number.isSafeInteger(message) && (message as number) >= 0 && Number.isSafeInteger(option) && (option as number) >= 0) {
          await (action === 'apply-suggestion' ? actions.applySuggestion : actions.publishSuggestion)(id, message as number, option as number);
          if (action === 'apply-suggestion') sendFiles();
        } else if (action === 'discard-suggestion' && typeof id === 'string' && state.threads.some((thread) => thread.id === id)) {
          await actions.discardSuggestion(id);
          sendFiles();
        } else if (action === 'dismiss-conflict-question') actions.dismissConflictQuestion();
        else if (action === 'fix-conflicts' && (text === undefined || isText(text))) {
          void actions.fixConflicts(text?.trim()).catch((error: unknown) => { post({ error: error instanceof Error ? error.message : String(error) }); });
        }
        else if (action === 'find-extension' && typeof extension === 'string' && /^[\w+-]{1,20}$/u.test(extension)) {
          await vscode.commands.executeCommand('workbench.extensions.search', `ext:${extension}`);
        }
        else if (action === 'commit-diff' && isOid(oid) && state.threads.some((thread) => thread.commits?.some((commit) => commit.oid === oid))) {
          try { post({ commitDiff: { oid, files: await actions.readCommit(oid) } }); } catch (error: unknown) { post({ commitDiff: { oid, error: error instanceof Error ? error.message : String(error) } }); }
        }
        else if (action === 'files' && typeof whitespace === 'boolean') {
          const commits = [
            ...(conversation()?.timeline ?? []).flatMap((item) => item.kind === 'commit' ? [item.oid] : []),
            ...state.threads.flatMap((thread) => thread.commits ?? []).map((commit) => commit.oid),
            ...(state.unpushed ?? []).map((commit) => commit.oid),
          ];
          const parsed = parseRange(range, commits);
          if (parsed !== undefined) sendFiles({ range: parsed, whitespace });
        } else if (action === 'conversation-comment' && isText(text)) {
          await actions.addComment(text.trim());
          post({ done: formKey });
        } else if (action === 'edit-comment' && commentKinds.includes(kind) && findComment(id, 'canEdit') && isText(text)) {
          await actions.editComment(kind as CommentKind, id as string, text.trim());
          post({ done: formKey });
        } else if (action === 'delete-issue-comment' && findComment(id, 'canDelete')) await actions.deleteIssueComment(id as string);
        else if (action === 'hide-comment' && typeof hide === 'boolean' && (!hide || hideReasons.includes(reason)) && findComment(id, 'canHide')) {
          await actions.hideComment(id as string, hide ? reason as HideReason : undefined);
        }
        else if (action === 'react' && reactionContents.includes(content as ReactionContent) && typeof on === 'boolean'
          && (findComment(id, 'canReact') || (id === conversation()?.description.id && conversation()?.description.canReact === true))) {
          await actions.react(id as string, content as ReactionContent, on);
        } else if (action === 'markdown' && typeof text === 'string' && text.length <= maximumReviewLength && formKey !== undefined) {
          post({ markdown: { form: formKey, html: text.trim() ? await actions.renderMarkdown(text) : '' } });
        }
        else if (action === 'branches') {
          try { post({ branches: await actions.branches() }); } catch (error: unknown) { post({ branchesError: error instanceof Error ? error.message : String(error) }); }
        }
        else if (action === 'picker-options') {
          try { post({ pickerOptions: await actions.pickerOptions() }); } catch (error: unknown) { post({ pickerError: error instanceof Error ? error.message : String(error) }); }
        }
        else if ((action === 'linked-open' || action === 'linked-push' || action === 'linked-draft' || action === 'unlink') && typeof key === 'string' && state.linked?.some((row) => row.key === key)) {
          if (action === 'linked-open') await actions.openLinked(key);
          else if (action === 'linked-push') await actions.pushLinked(key);
          else if (action === 'unlink') await actions.unlink(key);
          else post({ notice: { text: 'Opened a draft PR.', url: await actions.draftLinked(key) } });
          redraw();
        } else if (action === 'link' && typeof link === 'string' && link.length <= 500) {
          await actions.link(link);
          post({ done: 'link' });
          redraw();
        }
        else if (action === 'claude-conversations' && actions.claudeConversations !== undefined) {
          try { post({ conversations: await actions.claudeConversations() }); } catch (error: unknown) { post({ conversationsError: error instanceof Error ? error.message : String(error) }); }
        }
        else if (action === 'connect-claude' && actions.connectClaude !== undefined) {
          const choice = parseClaudeChoice(value);
          if (choice !== undefined) {
            const notice = await actions.connectClaude(choice);
            if (choice.how === 'running') post({ runningReady: true });
            if (notice !== undefined) post({ notice: { text: notice } });
          }
        }
        else if (action === 'copy-connect' && (command === 'reload' || command === 'connect')) {
          await vscode.env.clipboard.writeText(command === 'reload' ? '/reload-plugins --force' : '/diffguide:connect');
        }
        else if (action === 'open-pr' && actions.openPullRequest !== undefined) await actions.openPullRequest();
        else if (action === 'terminal') await actions.openTerminal();
        else if (action === 'push') await actions.push();
        else if (action === 'retry') actions.retry();
        else if (action === 'stop-claude') await actions.stopClaude();
        else if (action === 'new-conversation' && actions.newConversation !== undefined) {
          await actions.newConversation();
          post({ notice: { text: 'The next comment starts a new Claude conversation.' } });
        } else if (action === 'compact' && actions.compactConversation !== undefined) {
          void actions.compactConversation().then(() => { post({ notice: { text: 'Claude compacted the conversation.' } }); },
            (error: unknown) => { post({ error: error instanceof Error ? error.message : String(error) }); });
        } else if (action === 'draft-reply' && typeof id === 'string' && isOptionalText(text) && actions.draftReply !== undefined
          && state.threads.some((thread) => thread.id === id && thread.draft !== undefined)) {
          const drafted = await actions.draftReply(id, text ?? '');
          post({ drafted: { thread: id, text: drafted }, done: formKey });
        } else if (action === 'github-draft-reply' && typeof id === 'string' && isOptionalText(text) && actions.draftGitHubReply !== undefined
          && state.github?.some((thread) => thread.id === id && !thread.resolved)) {
          const drafted = await actions.draftGitHubReply(id, text ?? '');
          post({ drafted: { thread: id, text: drafted, github: true }, done: formKey });
        }
        else if (action === 'analyze') await actions.analyze();
        else if (action === 'analysis-stop') actions.stopAnalysis();
        else if ((action === 'review' || action === 'review-pick') && Array.isArray(reviewersPicked) && reviewersPicked.every((name) => allReviewers.includes(name as Reviewer))) {
          const picks = allReviewers.filter((name) => reviewersPicked.includes(name));
          if (action === 'review') await actions.review(picks); else await actions.pickReviewers(picks);
        } else if (action === 'review-stop') actions.stopReview();
        else if (action === 'review-recheck') {
          const open = state.threads.filter((thread) => thread.origin === 'review' && !thread.resolved && thread.archived !== true);
          for (const thread of open) await actions.reply(thread.id, recheckRequest, 'ask');
          post({ notice: { text: open.length === 1 ? 'Asked Claude to re-check 1 finding.' : `Asked Claude to re-check ${open.length} findings.` } });
        }
        else if (action === 'remove-worktree') { await actions.removeWorktree(); panel.dispose(); }
        else if (action === 'refresh') {
          // The poll follows a retargeted or moved base branch and GitHub's head.
          sync.now();
          sendFiles();
          const problem = await actions.refresh();
          post(problem === undefined ? { refreshed: true, notice: { text: 'Refreshed.' } } : { refreshed: true, error: 'Refresh failed: ' + problem });
        } else if (action === 'pr') await vscode.env.openExternal(vscode.Uri.parse(state.url));
        else if (action === 'thread' && typeof id === 'string') await actions.revealThread(id);
        else if (action === 'viewed' && typeof path === 'string' && typeof viewed === 'boolean') await marking(actions.setViewed(path, viewed));
        else if (action === 'read' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && typeof viewed === 'boolean') await marking(actions.markRead({ path, side, startLine, endLine }, viewed));
        else if (action === 'seen-answers' && isNameList(ids)) await actions.seeAnswers(ids.filter((each) => state.threads.some((thread) => thread.id === each)));
        else if (action === 'unread' && Array.isArray(ids) && ids.length <= 1000 && ids.every((item) => typeof item === 'string')) await marking(actions.unmarkRead(ids as string[]));
        else if (action === 'editor' && typeof path === 'string') await actions.openInEditor(path);
        else if (action === 'open-file' && typeof path === 'string' && actions.openFile !== undefined) await actions.openFile(path);
        else if (action === 'close-files' && isNameList(paths) && actions.closeFiles !== undefined) {
          await actions.closeFiles(paths);
          sendFiles();
        }
        else if (action === 'github' && typeof id === 'string') {
          const url = [...state.threads, ...state.github ?? []].find((thread) => thread.id === id)?.url;
          if (url !== undefined) await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (typeof action === 'string' && pullRequestActions.has(action) && !busy) {
          busy = true;
          try {
            if (editActions.has(action) && state.details?.canEdit !== true) {
              throw new Error('You do not have permission to edit this pull request.');
            }
            const merge = conversation()?.merge;
            const mergeMessage = (): MergeMessage => ({ ...typeof headline === 'string' && headline.trim() ? { headline: headline.trim() } : {}, ...typeof body === 'string' ? { body } : {} });
            if (action === 'review' && reviewEvents.includes(event as ReviewEvent) && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.submitReview(event as ReviewEvent, body.trim());
              post({ done: 'review' });
            } else if ((action === 'merge' || action === 'auto-merge') && mergeMethods.includes(method as MergeMethod) && isOptionalText(headline) && isOptionalText(body)
              && (deleteBranch === undefined || typeof deleteBranch === 'boolean')) {
              if (action === 'merge') await actions.merge(method as MergeMethod, mergeMessage(), deleteBranch === true);
              else if (merge?.canEnableAutoMerge === true) await actions.enableAutoMerge(method as MergeMethod, mergeMessage());
              else throw new Error(merge?.autoMergeAllowed === false ? 'Auto-merge is off in this repository\'s settings.' : 'GitHub does not offer auto-merge for this PR right now.');
              post({ done: 'merge' });
            } else if (action === 'auto-merge-off' && merge?.canDisableAutoMerge === true) await actions.disableAutoMerge();
            else if (action === 'enqueue' && merge?.mergeQueue === true) await actions.enqueue();
            else if (action === 'dequeue' && merge?.queuePosition !== undefined) await actions.dequeue();
            else if (action === 'update-branch' && (method === 'merge' || method === 'rebase') && merge?.canUpdateBranch === true) await actions.updateBranch(method);
            else if (action === 'discard-review' && state.details?.pendingComments !== undefined) await actions.discardReview();
            else if (action === 'dismiss-review' && typeof login === 'string' && isText(text) && conversation()?.reviewIds[login] !== undefined) {
              await actions.dismissReview(login, text.trim());
              post({ done: 'dismiss' });
            }
            else if (action === 'rerequest' && typeof login === 'string' && state.details?.reviewers.some((reviewer) => reviewer.name === login && reviewer.team === undefined)) await actions.rerequestReview(login);
            else if (action === 'rerun' && Number.isSafeInteger(run) && conversation()?.checks.some((check) => check.runId === run)) await actions.rerun(run as number);
            else if (action === 'approve-runs' && (conversation()?.awaitingApproval.length ?? 0) > 0) await actions.approveRuns();
            else if (action === 'revert' && state.details?.merged === true) {
              const created = await actions.revert();
              post({ notice: { text: `Opened #${created.number} to revert this PR.`, url: created.url } });
            }
            else if (action === 'restore-branch' && merge?.headDeleted === true) await actions.restoreBranch();
            else if (action === 'change-base' && state.details?.open === true && typeof branch === 'string' && branch.length <= 255) {
              await actions.changeBase(branch);
              sendFiles();
            } else if (action === 'commit-suggestions' && Array.isArray(picked) && picked.length > 0 && picked.length <= 100) {
              const valid = (picked as unknown[]).every((item) => {
                const { thread, comment } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
                return state.github?.some((entry) => entry.id === thread && !entry.outdated && entry.side === 'new' && entry.messages.some((each) => each.id === comment && each.suggestion === true));
              });
              if (!valid) throw new Error('A picked suggestion is no longer on this PR. Refresh and pick again.');
              await actions.commitSuggestions(picked as PickedSuggestion[]);
              post({ done: 'suggestions' });
              sendFiles();
            } else if (action === 'edit-title' && isText(title) && title.length <= 256) {
              await actions.editTitle(title.trim());
              post({ done: 'title' });
            }
            else if (action === 'edit-body' && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.editBody(body);
              post({ done: 'body' });
            } else if (action === 'pick' && pickTargets.includes(what) && isNameList(values) && isNameList(teams) && (what !== 'milestone' || (values.length <= 1 && values.every((entry) => /^\d{1,9}$/u.test(entry))))) {
              await actions.pick(what as PickTarget, { values, teams });
            }
            else if (action === 'draft' && typeof draft === 'boolean') await actions.setDraft(draft);
            else if (action === 'close' || action === 'reopen') await actions.setOpen(action === 'reopen');
            else if (action === 'delete-branch') await actions.deleteBranch();
          } finally {
            // GitHub writes can succeed before a later step or the response fails.
            // Re-read authoritative state even when the action rejects.
            void actions.refresh();
            redraw();
            busy = false;
            post({ idle: true });
          }
        }
      } catch (error: unknown) {
        post({ error: error instanceof Error ? error.message : String(error), form: formKey });
      }
    }),
  ];
  let shownProblem: string | undefined;
  const sync = pollWhileFocused(30_000, () => panel.visible, async () => {
    const { reload, files, problem, stale } = await actions.pollGitHub();
    if (reload) void actions.refresh();
    if (files) sendFiles();
    if (stale === true) post({ stale: true });
    if (problem !== undefined && problem !== shownProblem) post({ error: problem });
    shownProblem = problem;
  });
  subscriptions.push(sync, panel.onDidChangeViewState(({ webviewPanel }) => { if (webviewPanel.visible) sync.now(); }));
  if (onDidChangeFiles !== undefined) subscriptions.push(onDidChangeFiles(() => { sendFiles(); }));
  sync.now();
  const release = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    panels.delete(key);
  };
  const disposed = panel.onDidDispose(release);
}
/** Open review pages by key; `sendFiles` reads the files again and then shows `reveal`. */
const reviewPageType = 'diffGuide.pullRequestOverview';
const pageOptions = (extensionUri: vscode.Uri): vscode.WebviewOptions => ({ enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources'), vscode.Uri.joinPath(extensionUri, 'dist')] });
/** Tabs VS Code kept over a window reload, waiting for their page to open in them. */
const restored = new Map<string, vscode.WebviewPanel>();

/**
 * Reopen review pages in the tabs VS Code kept over a window reload. `open` opens the page a key names and
 * its tab closes when no page takes it, such as for a PR whose worktree is gone.
 */
export function restoreReviewPages(open: (key: string) => Promise<unknown>): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(reviewPageType, {
    async deserializeWebviewPanel(panel, state: unknown) {
      const key = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)['pageKey'] : undefined;
      if (typeof key !== 'string' || panels.has(key) || restored.has(key)) { panel.dispose(); return; }
      restored.set(key, panel);
      await open(key).catch(() => false);
      // The page opens in the tab by taking it from `restored`; a tab still there found no page.
      if (restored.get(key) === panel) { restored.delete(key); panel.dispose(); }
    },
  });
}

export const panels = new Map<string, { readonly panel: vscode.WebviewPanel; readonly sendFiles: (reveal?: OverviewReveal) => void; readonly detach: () => vscode.WebviewPanel }>();
