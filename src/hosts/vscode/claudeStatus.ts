import * as vscode from 'vscode';
import { agentStatus } from '../../core/agent.js';
import type { Checkouts } from './checkouts.js';
import type { PullRequestSession } from './pullRequestSessions.js';

/** The orb in the agent's color: the icon of a sidebar row or review page tab while Claude works there. */
export const workingIcon = new vscode.ThemeIcon('diffguide-orb', new vscode.ThemeColor('diffGuide.agent'));

/** Call `then` each time a Claude run ends, since Claude may have changed the PR on GitHub, such as its title with `gh pr edit`. */
export function claudeFinished(runner: Pick<PullRequestSession['runner'], 'activity' | 'onDidChange'>, then: () => void): vscode.Disposable {
  let running = runner.activity.running;
  return runner.onDidChange(() => {
    if (running && !runner.activity.running) then();
    running = runner.activity.running;
  });
}

/** Open a PR's Claude log, and send comments again after a failed or skipped run. */
export function showClaude({ runner, output }: PullRequestSession): void {
  if (agentStatus(runner.activity).retry) runner.retry();
  output.show(true);
}

/** Tell the user once per failed run why Claude did not answer, instead of leaving comments waiting silently. */
export function reportClaudeFailures(sessions: Pick<Checkouts, 'onDidChangeState'>): vscode.Disposable {
  const reported = new WeakMap<PullRequestSession, string>();
  return sessions.onDidChangeState((opened) => {
    const { running, error, stopped } = opened.runner.activity;
    if (running || error === undefined || stopped === true) {
      reported.delete(opened);
      return;
    }
    if (reported.get(opened) === error) return;
    reported.set(opened, error);
    const log = 'Show log';
    const retry = 'Retry';
    void vscode.window.showErrorMessage(`Claude could not answer on ${opened.session.label}: ${error}`, retry, log).then((choice) => {
      if (choice === retry) opened.runner.retry();
      if (choice === log) opened.output.show(true);
    });
  });
}

/** The status bar item showing what Claude does for the PR of the focused editor, and the command it runs. */
export function registerClaudeStatus(checkouts: Checkouts): vscode.Disposable[] {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'diffGuide.showFocusedClaude';
  const focusedSession = (): PullRequestSession | undefined => {
    const document = vscode.window.activeTextEditor?.document;
    return document === undefined ? undefined : checkouts.forUri(document.uri);
  };
  const updateStatus = (): void => {
    const focused = focusedSession();
    if (focused === undefined) {
      status.hide();
      return;
    }
    const current = agentStatus(focused.runner.activity);
    status.text = `$(${current.icon}) ${focused.session.label} · ${current.text}`;
    status.tooltip = current.retry ? `${focused.runner.activity.error ?? 'Some comments were not picked up.'} Click to send them again.` : `Show what Claude did for ${focused.session.label}`;
    status.show();
  };
  updateStatus();
  return [
    status, checkouts.onDidChangeState(updateStatus), vscode.window.onDidChangeActiveTextEditor(updateStatus),
  ];
}
