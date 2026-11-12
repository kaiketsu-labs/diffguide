import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileAnchor, pullRequestAnchor } from '../../core/anchors.js';
import { githubFeedbackRequest } from '../../core/pullRequestComments.js';
import type { OverviewActions } from '../protocol.js';
import type { PageParts } from './context.js';

/** What an Implement without a note asks Claude in a thread that already has a conversation. */
export const implementThreadRequest = 'Implement what this thread discussed.';

export type ThreadActions = Pick<OverviewActions, 'comment' | 'commentOnFile' | 'reply' | 'resolve' | 'archive' | 'withdraw' | 'publish' | 'postToGitHub'
  | 'askAboutGitHub' | 'askAboutComment' | 'seeAnswers' | 'revealThread'>;

/** The page's actions on Local threads: comments to Claude, and questions about GitHub's comments. */
export function threadActions({ page, remote, diff, findThread }: PageParts): ThreadActions {
  const { folder, opened, host } = page;
  const { store } = opened.session;
  return {
    comment: async ({ text, intent, ...lines }) => {
      const { anchor } = await diff.anchor(lines);
      await store.submit(anchor, text, intent);
    },
    commentOnFile: async (path, text, intent) => {
      diff.requireInDiff(path);
      if (!diff.atHead) throw new Error('Show all changes to comment on this file.');
      const base = await diff.readBase();
      await store.submit(fileAnchor(await readFile(join(folder, path), 'utf8'), { path, side: 'working', baseRevision: base }), text, intent);
    },
    reply: async (id, text, intent) => {
      const thread = findThread(id);
      if (thread.resolved) throw new Error('Reopen this thread before replying.');
      if (thread.archived) throw new Error('Unarchive this thread before replying.');
      await store.submit(thread.anchor, text || implementThreadRequest, intent, id);
    },
    resolve: (id, resolved) => store.resolve(findThread(id).id, resolved),
    archive: (id, archived) => store.archive(findThread(id).id, archived),
    withdraw: async (id) => {
      const thread = findThread(id);
      // A background run was given the comment in its prompt, whether or not Claude confirmed it yet.
      const running = opened.runner.activity.running && opened.runner.activity.threads.has(thread.id);
      if (running) await opened.runner.stop();
      const taken = await store.withdraw(thread.id);
      return { ...taken, text: taken.text === implementThreadRequest ? '' : taken.text, received: taken.received || running };
    },
    publish: async (id) => { await opened.session.publish?.(findThread(id).id); },
    postToGitHub: async (id, text, pending) => {
      const thread = findThread(id);
      await opened.session.postToGitHub?.(thread.id, text, pending);
      if (thread.anchor.scope === 'pullRequest') void remote.loadConversation();
    },
    askAboutGitHub: async (id, note, intent) => {
      const loaded = await remote.threads();
      const thread = loaded instanceof Error ? undefined : loaded.find((each) => each.id === id);
      if (thread === undefined) throw new Error('This GitHub thread no longer exists.');
      // An outdated thread's lines no longer hold its code, so its local thread is about the whole file.
      const wholeFile = thread.scope === 'file' || thread.outdated;
      const anchor = wholeFile
        ? fileAnchor(await readFile(join(folder, thread.path), 'utf8'), { path: thread.path, side: 'working', baseRevision: await diff.readBase() })
        : (await diff.anchor({ path: thread.path, side: thread.side === 'LEFT' ? 'old' : 'new', startLine: thread.startLine, endLine: thread.endLine })).anchor;
      const comments = thread.comments.filter((comment) => comment.hidden === undefined);
      const earlier = thread.outdated && thread.scope !== 'file';
      const source = earlier ? `GitHub thread on lines ${thread.startLine}-${thread.endLine} of an earlier version of ${thread.path}; the code changed since` : undefined;
      const request = githubFeedbackRequest(note, intent, comments, source);
      const hunk = earlier && thread.diffHunk !== undefined ? `\n\nThe diff the comment was written on:\n\n\`\`\`\`diff\n${thread.diffHunk}\n\`\`\`\`` : '';
      const created = await store.submit(anchor, request + hunk, intent);
      await opened.session.linkToGitHub?.(created.id, { id: thread.id, url: thread.url });
    },
    askAboutComment: async (id, note, intent) => {
      const comment = (await remote.currentConversation()).timeline.find((item) => (item.kind === 'comment' || item.kind === 'review') && item.id === id);
      if (comment === undefined || comment.kind === 'commit' || comment.kind === 'event' || !comment.body.trim()) throw new Error('This comment no longer exists.');
      const request = githubFeedbackRequest(note, intent, [comment], 'GitHub PR comment');
      const created = await store.submit(pullRequestAnchor(await diff.readBase()), request, intent);
      await opened.session.linkToGitHub?.(created.id, { id: comment.id, url: comment.url ?? page.pullRequest.url });
    },
    seeAnswers: (ids) => host.seeAnswers(ids),
    revealThread: async (id) => {
      const { path, scope } = findThread(id).anchor;
      if (scope === 'pullRequest') { host.reveal({ thread: id }); return; }
      if (diff.selection.range.kind !== 'all') { await host.openInEditor(diff.current(), path); return; }
      page.revealed.add(path);
      host.reveal({ path, reload: true });
    },
  };
}
