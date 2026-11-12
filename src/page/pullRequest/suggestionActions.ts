import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAndPush, commitFiles, syncKeepingLocalCommits } from '../../core/conflicts.js';
import { readGitBase } from '../../core/git/git.js';
import { git } from '../../core/git/worktrees.js';
import { applySuggestion, parseSuggestions, suggestionLines, suggestionMarkdown } from '../../core/suggestions.js';
import type { OverviewActions } from '../protocol.js';
import type { PageParts } from './context.js';

export type SuggestionActions = Pick<OverviewActions, 'applySuggestion' | 'discardSuggestion' | 'publishSuggestion'>;

/** The page's actions on code suggestions in Local threads: apply them to the worktree, undo that, or post them on GitHub. */
export function suggestionActions({ page, remote, diff, edits, findThread, pushTarget }: PageParts): SuggestionActions {
  const { provider, pullRequest, folder, role, opened } = page;
  const { applied, undo } = edits;
  return {
    applySuggestion: async (id, message, option) => {
      const { anchor, messages } = findThread(id);
      const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
      if (suggestion === undefined || anchor.scope !== undefined) throw new Error('This suggestion no longer exists.');
      if (anchor.side !== 'working') throw new Error('Suggestions apply only to the PR\'s version of a file.');
      if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Apply the suggestion when it is done.');
      const loaded = await remote.currentDetails();
      const file = join(folder, anchor.path);
      let ahead = false;
      if (loaded.canEdit) {
        if ((await git(folder, ['status', '--porcelain', '--', anchor.path])).trim() !== '') throw new Error(`${anchor.path} has uncommitted changes. Commit or discard them first.`);
        // On your own checkout the suggestion becomes a local commit you push yourself, so the branch never moves under you.
        ahead = page.onCheckout || (await syncKeepingLocalCommits(folder, pullRequest.number)).ahead;
      }
      const before = await readFile(file, 'utf8');
      const after = applySuggestion(before, anchor, suggestion);
      await writeFile(file, after);
      const commit = { path: anchor.path, message: 'Apply suggestion from code review', hooksOff: role === 'reviewer' };
      if (!loaded.canEdit) undo.set(id, { path: anchor.path, before, after });
      else if (ahead) await commitFiles(folder, commit);
      else {
        await commitAndPush(folder, { ...commit, pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch });
        remote.changedOnGitHub();
      }
      applied.set(id, { message, option, done: !loaded.canEdit ? 'applied' : ahead ? 'committed' : 'pushed' });
      remote.changed();
    },
    discardSuggestion: async (id) => {
      const change = undo.get(id);
      if (change === undefined) throw new Error('There is no applied suggestion to discard.');
      const file = join(folder, change.path);
      if (await readFile(file, 'utf8') !== change.after) throw new Error(`${change.path} changed since the suggestion was applied, so it was not discarded.`);
      await writeFile(file, change.before);
      undo.delete(id);
      applied.delete(id);
      remote.changed();
    },
    publishSuggestion: async (id, message, option) => {
      const { anchor, messages } = findThread(id);
      const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
      if (suggestion === undefined || anchor.scope !== undefined) throw new Error('This suggestion no longer exists.');
      if (anchor.side !== 'working') throw new Error('GitHub takes suggestions only on the PR\'s version of a file.');
      const head = await diff.readHead();
      const lines = suggestionLines(await readGitBase(folder, anchor.path, head), anchor);
      await provider.publishComment(pullRequest.number, { path: anchor.path, body: suggestionMarkdown(suggestion), commitId: head, side: 'RIGHT', lines }, true);
      void remote.loadThreads();
      void remote.loadDetails();
    },
  };
}
