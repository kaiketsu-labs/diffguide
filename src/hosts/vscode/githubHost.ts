import * as vscode from 'vscode';
import type { GitHubHost } from '../../forges/github/githubApi.js';

/** GitHub sign-ins and settings from VS Code's accounts. */
export const vscodeGitHubHost: GitHubHost = {
  async token(provider, scopes, mode) {
    const options = mode === 'silent' ? { silent: true } : mode === 'create' ? { createIfNone: true } : { forceNewSession: true };
    return (await vscode.authentication.getSession(provider, scopes, options))?.accessToken;
  },
  enterpriseUri: () => vscode.workspace.getConfiguration('github-enterprise').get<string>('uri'),
  onDidChangeSessions: (listener) => vscode.authentication.onDidChangeSessions(({ provider }) => listener(provider.id)),
};
