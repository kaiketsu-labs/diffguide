import { endpointsFor, githubRequest } from './githubApi.js';
import { parseGitRemote, pickGitHubRemote } from './pullRequests.js';
import { git } from './worktrees.js';
import { prExportEnd, prExportStart, readManagedPrContent, replaceManagedPrContent } from './prExport.js';

/** Open PR whose head is the current workspace branch. */
export interface GitHubPullRequest {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly branch: string;
}

/** Managed PR conversation comment belonging to the authenticated GitHub user. */
export interface GitHubHandoffComment {
  readonly id: number;
  readonly body: string;
  readonly url: string;
}

/** Remote state captured when the human opens the handoff preview. */
export interface GitHubHandoffTarget {
  readonly pullRequest: GitHubPullRequest;
  readonly viewerLogin: string;
  readonly comment?: GitHubHandoffComment;
}

/** Successful publication and the resulting target for subsequent updates. */
export interface GitHubHandoffResult {
  readonly target: GitHubHandoffTarget;
  readonly comment: GitHubHandoffComment;
  readonly changed: boolean;
}

/** Upper bound for reading a PR's conversation, 100 comments per page. */
const maxCommentPages = 100;

/** Use the user's GitHub sign-in in VS Code without collecting account credentials. */
export class GitHubReviewClient {
  private constructor(private readonly workspaceRoot: string) {}

  /** Connect to the GitHub repository the workspace's git remotes point to. */
  static async connect(workspaceRoot: string): Promise<GitHubReviewClient> {
    return new GitHubReviewClient(workspaceRoot);
  }

  /** Detect one open PR and the current user's existing managed handoff comment. */
  async readTarget(): Promise<GitHubHandoffTarget> {
    const pullRequest = await this.#currentPullRequest();
    const user = object(await this.#api(pullRequest.host, 'GET', 'user'));
    const viewerLogin = text(user['login'], 'GitHub-Konto');
    const matches: GitHubHandoffComment[] = [];
    for (let page = 1; page <= maxCommentPages; page++) {
      const comments = await this.#api(pullRequest.host, 'GET',
        `repos/${pullRequest.owner}/${pullRequest.repository}/issues/${pullRequest.number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error('GitHub hat keine gültige Kommentarliste geliefert.');
      for (const value of comments as readonly unknown[]) {
        const record = object(value);
        const author = optionalObject(record['user']);
        if (typeof author?.['login'] !== 'string' || author['login'].toLowerCase() !== viewerLogin.toLowerCase()) continue;
        const body = text(record['body'], 'Kommentartext', true);
        if (!body.includes(prExportStart) && !body.includes(prExportEnd)) continue;
        readManagedPrContent(body);
        matches.push(parseComment(record));
      }
      if (comments.length < 100) break;
    }
    if (matches.length > 1) {
      throw new Error('Dieser PR enthält mehrere Local-Review-Übergaben von deinem Konto. Kläre die doppelten Kommentare auf GitHub, bevor du aktualisierst.');
    }
    const comment = matches[0];
    return comment === undefined ? { pullRequest, viewerLogin } : { pullRequest, viewerLogin, comment };
  }

  /** Reconcile retries and update only this user's exact managed comment after an explicit publish action. */
  async publish(expected: GitHubHandoffTarget, markdown: string): Promise<GitHubHandoffResult> {
    replaceManagedPrContent(undefined, markdown);
    const current = await this.readTarget();
    if (current.pullRequest.url !== expected.pullRequest.url || current.pullRequest.branch !== expected.pullRequest.branch) {
      throw new Error('Der aktive Branch oder PR hat sich geändert. Schließe die Vorschau und erstelle eine neue Übergabe.');
    }
    if (current.viewerLogin.toLowerCase() !== expected.viewerLogin.toLowerCase()) {
      throw new Error('Das aktive GitHub-Konto hat sich geändert. Erstelle die Vorschau mit dem gewünschten Konto erneut.');
    }
    const existing = current.comment;
    const currentContent = existing === undefined ? undefined : readManagedPrContent(existing.body);
    const wanted = markdown.trim();
    if (existing !== undefined && currentContent?.content === wanted) {
      return { target: current, comment: existing, changed: false };
    }
    const expectedContent = expected.comment === undefined ? undefined : readManagedPrContent(expected.comment.body);
    if (existing?.id !== expected.comment?.id || currentContent?.content !== expectedContent?.content) {
      throw new Error('Die Übergabe wurde inzwischen auf GitHub geändert oder entfernt. Deine Vorschau bleibt erhalten. Erstelle eine neue Vorschau, um den aktuellen Stand zu übernehmen.');
    }
    const body = replaceManagedPrContent(existing?.body, wanted);
    const pr = current.pullRequest;
    const endpoint = existing === undefined
      ? `repos/${pr.owner}/${pr.repository}/issues/${pr.number}/comments`
      : `repos/${pr.owner}/${pr.repository}/issues/comments/${existing.id}`;
    const comment = parseComment(await this.#api(pr.host, existing === undefined ? 'POST' : 'PATCH', endpoint, { body }));
    return { target: { ...current, comment }, comment, changed: true };
  }

  /** The open PR whose head is the checked-out branch, in the repository GitHub CLI would pick from the remotes. */
  async #currentPullRequest(): Promise<GitHubPullRequest> {
    const [config, branch] = await Promise.all([
      git(this.workspaceRoot, ['config', '--get-regexp', '^(remote|branch)\\.']).catch(() => ''),
      git(this.workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((name) => name.trim(), () => ''),
    ]);
    const base = pickGitHubRemote(config);
    if (base === undefined) throw new Error('Dieses Repository hat kein GitHub-Remote.');
    if (branch === '') throw new Error('Kein Branch ausgecheckt. Wechsle auf den Branch deines PRs.');
    const head = branchHead(config, branch);
    const data = object(await this.#api(base.host, 'POST', 'graphql', {
      query: 'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$head,states:OPEN,first:20){nodes{number url title state headRefName headRepositoryOwner{login}}}}}',
      variables: { owner: base.owner, name: base.name, head: head.branch },
    }));
    const nodes = Array.isArray(data['errors']) ? undefined
      : optionalObject(optionalObject(optionalObject(data['data'])?.['repository'])?.['pullRequests'])?.['nodes'];
    if (!Array.isArray(nodes)) throw new Error('GitHub hat keine gültige PR-Liste geliefert.');
    const open = (nodes as readonly unknown[]).map(object);
    const owned = head.owner === undefined ? open
      : open.filter((node) => String(optionalObject(node['headRepositoryOwner'])?.['login']).toLowerCase() === head.owner);
    const candidates = owned.length > 0 ? owned : open;
    if (candidates.length === 0) throw new Error('Der aktuelle Branch hat keinen offenen GitHub-PR. Öffne oder erstelle zuerst einen PR für diesen Branch.');
    if (candidates.length > 1) throw new Error('Für diesen Branch gibt es mehrere offene PRs. Schließe die überzähligen PRs auf GitHub.');
    return parsePullRequest(candidates[0], base.host);
  }

  /** Call the GitHub API, keeping the reason and warning that a failed write may still have happened. */
  async #api(host: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const endpoints = endpointsFor(host);
    const url = path === 'graphql' ? endpoints.graphql : `${endpoints.rest}/${path}`;
    try {
      return await githubRequest(endpoints, url, method, body, true);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const write = method !== 'GET' && path !== 'graphql';
      throw new Error(`GitHub konnte die PR-Übergabe nicht abschließen. ${reason}${write ? '\n\nDer Schreibvorgang kann bereits erfolgt sein. „Erneut versuchen“ gleicht den vorhandenen Kommentar ab.' : ''}`);
    }
  }
}

/** The branch name a local branch pushes to and, when its upstream remote is a GitHub repository, that repository's owner. */
export function branchHead(config: string, branch: string): { readonly branch: string; readonly owner?: string } {
  const value = (key: string): string | undefined => {
    for (const line of config.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key} `)) return trimmed.slice(key.length + 1);
    }
    return undefined;
  };
  const merge = value(`branch.${branch}.merge`);
  const remote = value(`branch.${branch}.remote`);
  const url = remote === undefined ? undefined : value(`remote.${remote}.url`);
  const owner = url === undefined ? undefined : parseGitRemote(url)?.owner.toLowerCase();
  const name = merge?.startsWith('refs/heads/') === true ? merge.slice('refs/heads/'.length) : branch;
  return owner === undefined ? { branch: name } : { branch: name, owner };
}

/** Validate the selected PR and require its link to stay on the repository's GitHub host. */
function parsePullRequest(value: unknown, host: string): GitHubPullRequest {
  const record = object(value);
  if (record['state'] !== 'OPEN') throw new Error('Der aktuelle Branch hat keinen offenen GitHub-PR. Öffne oder erstelle zuerst einen PR für diesen Branch.');
  const url = new URL(text(record['url'], 'PR-Adresse'));
  const parts = url.pathname.split('/').filter(Boolean);
  const [owner, repository, kind, numberText] = parts;
  const number = Number(numberText);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.hostname.toLowerCase() !== host
    || parts.length !== 4 || owner === undefined || repository === undefined || kind !== 'pull'
    || !/^[a-z\d_.-]+$/iu.test(owner) || !/^[a-z\d_.-]+$/iu.test(repository)
    || owner === '.' || owner === '..' || repository === '.' || repository === '..'
    || !Number.isSafeInteger(number) || number <= 0 || record['number'] !== number) {
    throw new Error('GitHub hat keine eindeutige PR-Adresse geliefert.');
  }
  return {
    host, owner, repository, number, url: url.toString(),
    title: text(record['title'], 'PR-Titel'), branch: text(record['headRefName'], 'PR-Branch'),
  };
}

/** Validate an API comment before using its identifier in an update endpoint. */
function parseComment(value: unknown): GitHubHandoffComment {
  const record = object(value);
  const id = record['id'];
  const url = new URL(text(record['html_url'], 'Kommentaradresse'));
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GitHub hat keinen gültigen Kommentar geliefert.');
  }
  return { id, body: text(record['body'], 'Kommentartext', true), url: url.toString() };
}

/** Narrow an untrusted GitHub response before inspecting its properties. */
function object(value: unknown): Record<string, unknown> {
  const record = optionalObject(value);
  if (record === undefined) throw new Error('GitHub hat unvollständige Daten geliefert.');
  return record;
}

/** Recognize a JSON object without trusting arrays or null values. */
function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Require textual API fields without coercion. */
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`GitHub hat kein gültiges Feld „${label}“ geliefert.`);
  return value;
}
