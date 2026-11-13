import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileAnchor } from '../../core/anchors.js';
import { git } from '../../core/git/worktrees.js';
import { placeComment } from '../../core/pullRequestComments.js';
import type { OverviewActions } from '../protocol.js';
import { saveSelection } from '../pullRequestEdits.js';
import { type GitHubPageActions, githubPageActions } from '../pullRequestPageActions.js';
import type { PageParts } from './context.js';

export type GitHubActions = GitHubPageActions & Pick<OverviewActions, 'commentOnGitHub' | 'commentOnGitHubFile' | 'replyOnGitHub' | 'resolveOnGitHub' | 'deleteOnGitHub'
  | 'submitReview' | 'editTitle' | 'editBody' | 'pickerOptions' | 'pick' | 'setDraft' | 'setOpen' | 'merge' | 'deleteBranch'>;

/** The page's actions on the PR on GitHub: its threads, reviews, title, state and merge. */
export function githubActions({ page, remote, diff, pushTarget }: PageParts): GitHubActions {
  const { provider, pullRequest, folder, role, host } = page;
  const { number } = pullRequest;
  const { written } = remote;
  return {
    commentOnGitHub: async ({ text, ...lines }, pending) => {
      const { anchor, base } = await diff.anchor(lines);
      const placement = await placeComment(folder, base, anchor);
      if (placement.lines === undefined) throw new Error('GitHub only takes comments on lines its diff shows. Pick lines inside a changed section.');
      await provider.publishComment(number, { ...placement, body: text }, pending);
      await Promise.all([remote.loadThreads(), remote.loadDetails()]);
    },
    commentOnGitHubFile: async (path, text, pending) => {
      diff.requireInDiff(path);
      const base = await diff.readBase();
      const anchor = fileAnchor(await readFile(join(folder, path), 'utf8'), { path, side: 'working', baseRevision: base });
      await provider.publishComment(number, { ...await placeComment(folder, base, anchor), body: text }, pending);
      await Promise.all([remote.loadThreads(), remote.loadDetails()]);
    },
    replyOnGitHub: async (id, text) => {
      await provider.replyToThread(id, text);
      await remote.loadThreads();
    },
    resolveOnGitHub: async (id, resolved) => {
      await provider.resolveThread(id, resolved);
      written.expect(`resolved:${id}`, resolved);
      await remote.loadThreads();
    },
    deleteOnGitHub: async (id) => {
      await provider.deleteComment(id);
      await Promise.all([remote.loadThreads(), remote.loadDetails()]);
    },
    submitReview: async (event, body) => {
      await provider.submitReview(number, event, body);
      void remote.loadDetails();
      void remote.loadConversation();
      void remote.loadThreads();
    },
    merge: async (method, message, deleteBranch) => {
      const { branchDeletable } = await remote.currentDetails();
      try {
        await provider.merge(number, method, message);
        await host.markMerged();
        if (deleteBranch && branchDeletable) await provider.deleteBranch(pullRequest.headBranch);
      } finally {
        remote.changedOnGitHub();
      }
    },
    editTitle: async (next) => {
      const { title } = await remote.currentDetails();
      if (next === title) return;
      await provider.editPullRequest(number, { title: next });
      written.expect('title', next);
      remote.changedOnGitHub();
    },
    editBody: async (body) => {
      await provider.editPullRequest(number, { body });
      void remote.loadDetails();
    },
    pickerOptions: () => provider.pickerOptions(),
    pick: async (what, picked) => {
      try {
        await saveSelection(provider, number, await remote.currentDetails(), what, picked);
      } finally {
        if (what === 'reviewers') remote.changedOnGitHub(); else void remote.loadDetails();
      }
    },
    setDraft: async (draft) => {
      await provider.setDraft(number, draft);
      written.expect('draft', draft);
      remote.changedOnGitHub();
    },
    setOpen: async (open) => {
      await provider.editPullRequest(number, { state: open ? 'open' : 'closed' });
      written.expect('open', open);
      remote.changedOnGitHub();
    },
    deleteBranch: async () => {
      await provider.deleteBranch(pullRequest.headBranch);
      void remote.loadDetails();
    },
    ...githubPageActions({
      provider, number, headBranch: pullRequest.headBranch, baseBranch: () => diff.baseBranch, folder, hooksOff: role === 'reviewer', keepCheckout: page.onCheckout,
      details: () => remote.currentDetails(), conversation: () => remote.currentConversation(),
      threads: async () => { const loaded = await remote.loadThreads(); if (loaded instanceof Error) throw loaded; return loaded; },
      pushTarget, claudeBusy: () => page.opened.runner.activity.running,
      reload: (listed) => { if (listed === true) remote.changedOnGitHub(); else { void remote.loadDetails(); void remote.loadConversation(); } void remote.loadThreads(); },
      useBase: async (branch) => {
        await git(folder, ['fetch', '--quiet', 'origin', branch]).catch(() => undefined);
        diff.baseBranch = branch;
        await page.opened.useBase(branch);
      },
    }),
  };
}
