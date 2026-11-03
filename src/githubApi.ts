import * as vscode from 'vscode';

type AuthProvider = 'github' | 'github-enterprise';

/** Where a GitHub host serves its API, and which VS Code sign-in it takes. */
export interface GitHubEndpoints {
  readonly rest: string;
  readonly graphql: string;
  readonly authProvider: AuthProvider;
}

/** Only `repo` reaches private repositories; GitHub offers no narrower scope for reading them. `read:org` reads team reviewer names. */
const scopes = ['repo', 'read:org'];
const requestTimeoutMs = 30_000;

/** API addresses for github.com, or for the one enterprise host VS Code's `github-enterprise.uri` names. */
export function githubEndpoints(host: string, enterpriseUri: string | undefined): GitHubEndpoints {
  if (host === 'github.com') return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', authProvider: 'github' };
  if (enterpriseHost(enterpriseUri) !== host) throw new Error(`Set "github-enterprise.uri" to https://${host} to sign in to this GitHub host.`);
  if (host.endsWith('.ghe.com')) return { rest: `https://api.${host}`, graphql: `https://api.${host}/graphql`, authProvider: 'github-enterprise' };
  return { rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql`, authProvider: 'github-enterprise' };
}

function enterpriseHost(uri: string | undefined): string | undefined {
  try {
    return uri === undefined || uri === '' ? undefined : new URL(uri).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Endpoints for a host under the user's current `github-enterprise.uri` setting. */
export function endpointsFor(host: string): GitHubEndpoints {
  return githubEndpoints(host, vscode.workspace.getConfiguration('github-enterprise').get<string>('uri'));
}

const tokens = new Map<AuthProvider, Promise<string>>();
/** Providers whose session GitHub refused, so signing in again asks for a new one. */
const rejected = new Set<AuthProvider>();
let lastMissing: AuthProvider = 'github';

/** No usable GitHub sign-in in VS Code for this provider; `signInToGitHub` fixes it. */
export class GitHubSignInRequired extends Error {
  constructor(readonly provider: AuthProvider, message = 'Sign in to GitHub to load pull requests.') {
    super(message);
    lastMissing = provider;
  }
}

/** The user's VS Code GitHub sign-in; `interactive` asks for it when missing instead of failing. */
function token(provider: AuthProvider, interactive: boolean): Promise<string> {
  let found = tokens.get(provider);
  if (found === undefined) {
    found = interactive ? signInToGitHub(provider) : Promise.resolve(vscode.authentication.getSession(provider, scopes, { silent: true })).then((session) => {
      if (session === undefined) throw new GitHubSignInRequired(provider);
      return session.accessToken;
    });
    found.catch(() => { tokens.delete(provider); });
    tokens.set(provider, found);
  }
  return found;
}

/** Show VS Code's GitHub sign-in, for the provider that last needed one when none is given. */
export async function signInToGitHub(provider: AuthProvider = lastMissing): Promise<string> {
  const session = rejected.has(provider)
    ? await vscode.authentication.getSession(provider, scopes, { forceNewSession: true })
    : await vscode.authentication.getSession(provider, scopes, { createIfNone: true });
  rejected.delete(provider);
  tokens.set(provider, Promise.resolve(session.accessToken));
  return session.accessToken;
}

/** Drop cached sign-ins and notify `onChange` when the user signs in or out of GitHub in VS Code. */
export function watchGitHubSessions(onChange: () => void): vscode.Disposable {
  return vscode.authentication.onDidChangeSessions(({ provider }) => {
    if (provider.id !== 'github' && provider.id !== 'github-enterprise') return;
    tokens.clear();
    onChange();
  });
}

/** Call the GitHub API as the signed-in user; the token goes only to the host's own API and redirects are refused. */
export async function githubRequest(endpoints: GitHubEndpoints, url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, interactive = false): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await token(endpoints.authProvider, interactive)}`,
      'User-Agent': 'pair-review',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  if (response.status === 401) {
    tokens.delete(endpoints.authProvider);
    rejected.add(endpoints.authProvider);
    throw new GitHubSignInRequired(endpoints.authProvider, 'GitHub refused your sign-in. Sign in to GitHub again.');
  }
  if (!response.ok) {
    const detail = errorDetail(text).slice(0, 600).replaceAll(/(?:gh[pousr]_[A-Za-z\d_]+|github_pat_[A-Za-z\d_]+)/gu, '[credential]');
    throw new Error(`GitHub request failed (${response.status}).${detail ? ` ${detail}` : ''}`);
  }
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('GitHub returned invalid data.');
  }
}

/** GitHub's reasons from a failed API call: its message and each listed error. */
export function errorDetail(body: string): string {
  try {
    const { message, errors } = JSON.parse(body) as { message?: unknown; errors?: unknown };
    const reasons = Array.isArray(errors) ? errors.map((error: unknown) => typeof error === 'string' ? error
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '') : [];
    return [typeof message === 'string' ? message : '', ...reasons].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}
