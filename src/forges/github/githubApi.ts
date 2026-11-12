import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

type AuthProvider = 'github' | 'github-enterprise';

/** Where a GitHub host serves its API, and which VS Code sign-in it takes. */
export interface GitHubEndpoints {
  readonly host: string;
  readonly rest: string;
  readonly graphql: string;
  readonly authProvider: AuthProvider;
}

/** Only `repo` reaches private repositories; GitHub offers no narrower scope for reading them. `read:org` reads team reviewer names. */
const scopes = ['repo', 'read:org'];
const requestTimeoutMs = 30_000;

/** API addresses for github.com, or for the one enterprise host VS Code's `github-enterprise.uri` names. */
export function githubEndpoints(host: string, enterpriseUri: string | undefined): GitHubEndpoints {
  if (host === 'github.com') return { host, rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', authProvider: 'github' };
  if (enterpriseHost(enterpriseUri) !== host) throw new Error(`Set "github-enterprise.uri" to https://${host} to sign in to this GitHub host.`);
  if (host.endsWith('.ghe.com')) return { host, rest: `https://api.${host}`, graphql: `https://api.${host}/graphql`, authProvider: 'github-enterprise' };
  return { host, rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql`, authProvider: 'github-enterprise' };
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

/** The user's VS Code GitHub sign-in, else GitHub CLI's; `interactive` asks for a VS Code sign-in when missing instead of failing. */
function token({ host, authProvider: provider }: GitHubEndpoints, interactive: boolean): Promise<string> {
  let found = tokens.get(provider);
  if (found === undefined) {
    found = interactive ? signInToGitHub(provider) : Promise.resolve(vscode.authentication.getSession(provider, scopes, { silent: true })).then(async (session) => {
      const accessToken = session?.accessToken ?? await ghToken(host);
      if (accessToken === undefined) throw new GitHubSignInRequired(provider);
      return accessToken;
    });
    found.catch(() => { tokens.delete(provider); });
    tokens.set(provider, found);
  }
  return found;
}

/** VS Code started from the Dock lacks the shell's PATH, so also try Homebrew's install locations. */
const ghExecutables = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

/** The token GitHub CLI holds for `host`, or undefined when gh is missing or signed out there. */
async function ghToken(host: string): Promise<string | undefined> {
  for (const executable of ghExecutables) {
    const found = await new Promise<string | undefined>((resolve) => {
      execFile(executable, ['auth', 'token', '--hostname', host], { timeout: 10_000 }, (error, stdout) => {
        resolve(error === null && stdout.trim() !== '' ? stdout.trim() : undefined);
      });
    });
    if (found !== undefined) return found;
  }
  return undefined;
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
      Authorization: `Bearer ${await token(endpoints, interactive)}`,
      'User-Agent': 'diffguide',
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
  if (!(response.headers.get('content-type') ?? 'application/json').includes('json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('GitHub returned invalid data.');
  }
}

/** A GET answered with its ETag, for asking later whether it changed. */
export interface Polled { readonly etag: string; readonly data: unknown }

/** GET `url` again; returns `known` itself when GitHub answers 304, which does not count against the rate limit. */
export async function githubPoll(endpoints: GitHubEndpoints, url: string, known?: Polled): Promise<Polled> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await token(endpoints, false)}`,
      'User-Agent': 'diffguide',
      ...(known === undefined ? {} : { 'If-None-Match': known.etag }),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 304 && known !== undefined) return known;
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
  return { etag: response.headers.get('etag') ?? '', data: await response.json() as unknown };
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
