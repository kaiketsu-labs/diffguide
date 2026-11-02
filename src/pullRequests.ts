import { execFile } from 'node:child_process';
import { findGitHubCli } from './github.js';
import { git } from './worktrees.js';

/** Open pull request shown in the sidebar, validated from provider output. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** Strongest verdict among reviewers' latest reviews; absent when nobody reviewed yet. */
  readonly review?: ReviewVerdict;
}

export type ReviewVerdict = 'approved' | 'changes' | 'commented';

/** Changes requested outweighs approval, which outweighs plain comments. */
export function strongestVerdict(states: readonly string[]): ReviewVerdict | undefined {
  if (states.includes('CHANGES_REQUESTED')) return 'changes';
  if (states.includes('APPROVED')) return 'approved';
  if (states.includes('COMMENTED')) return 'commented';
  return undefined;
}

/** File changed by a pull request, as the code host reports it. */
export interface PullRequestFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
}

/** Repository whose pull requests the sidebar lists. */
export interface PullRequestRepository {
  readonly name: string;
  readonly url: string;
}

/** A comment for the PR's diff; without `lines` it applies to the whole file. */
export interface PullRequestComment {
  readonly path: string;
  readonly body: string;
  readonly commitId: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly lines?: { readonly start: number; readonly end: number };
}

/** A PR's description, review and CI state, as the overview shows them. */
export interface PullRequestDetails {
  /** Description already rendered and sanitized by the code host. */
  readonly bodyHtml: string;
  readonly open: boolean;
  readonly mergeable: 'yes' | 'no' | 'unknown';
  readonly viewerIsAuthor: boolean;
  /** Comments in the viewer's unsubmitted review; undefined when there is no such review. */
  readonly pendingComments?: number;
  readonly mergeMethods: readonly MergeMethod[];
  readonly reviewers: readonly { readonly name: string; readonly state: 'requested' | 'approved' | 'changes' | 'commented' | 'dismissed' }[];
  readonly checks: readonly { readonly name: string; readonly state: 'success' | 'failure' | 'pending' | 'neutral'; readonly url?: string }[];
}

/** A diff comment thread on the code host, written by anyone. */
export interface RemoteThread {
  readonly id: string;
  readonly path: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly startLine: number;
  readonly endLine: number;
  /** The code changed since the comment, so its lines may no longer match. */
  readonly outdated: boolean;
  readonly resolved: boolean;
  readonly url: string;
  /** Still in the viewer's unsubmitted review, so only they see it. */
  readonly pending: boolean;
  /** Bodies come rendered and sanitized by GitHub. */
  readonly comments: readonly { readonly author: string; readonly avatarUrl: string; readonly pending: boolean; readonly bodyHtml: string }[];
}

export type ReviewEvent = 'approve' | 'requestChanges' | 'comment';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Pull request queries and the user's own review actions, implemented once per code host CLI. */
export interface PullRequestProvider {
  readRepository(): Promise<PullRequestRepository>;
  listMine(): Promise<readonly PullRequestSummary[]>;
  listReviewRequested(): Promise<readonly PullRequestSummary[]>;
  listFiles(number: number): Promise<readonly PullRequestFile[]>;
  /** Check the PR's head branch out into an existing worktree folder. */
  checkout(number: number, worktree: string): Promise<void>;
  /** Files the user marked "Viewed" on the code host. */
  viewedFiles(number: number): Promise<ReadonlySet<string>>;
  setViewed(number: number, path: string, viewed: boolean): Promise<void>;
  /** Post a diff comment, into the user's pending review or right away, and return its link. */
  publishComment(number: number, comment: PullRequestComment, pending: boolean): Promise<string>;
  details(number: number): Promise<PullRequestDetails>;
  threads(number: number): Promise<readonly RemoteThread[]>;
  /** Post a reply to a code host thread right away, visible to everyone. */
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  /** Submit the user's review, including comments already in their pending review. */
  submitReview(number: number, event: ReviewEvent, body: string): Promise<void>;
  merge(number: number, method: MergeMethod): Promise<void>;
}

/** A repository on a GitHub host, as a git remote names it. */
export interface GitHubRemote {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** Read a GitHub repository from an HTTPS, SSH or scp-style remote URL. */
export function parseGitRemote(url: string): GitHubRemote | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/:]+@([^/:]+):)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim());
  const host = match?.[1] ?? match?.[2] ?? match?.[3];
  const owner = match?.[4];
  const name = match?.[5];
  if (host === undefined || owner === undefined || name === undefined) return undefined;
  const valid = /^[A-Za-z0-9_.-]+$/u;
  return valid.test(owner) && valid.test(name) && valid.test(host) ? { host: host.toLowerCase(), owner, name } : undefined;
}

/** Order GitHub CLI uses when no default repository is set. */
const remotePriority = ['upstream', 'github', 'origin'];

/** The repository GitHub CLI picks from `git config --get-regexp ^remote\.` output: the `gh repo set-default` choice, else upstream, github, origin, then the rest. */
export function pickGitHubRemote(config: string): GitHubRemote | undefined {
  const remotes = new Map<string, { url?: string; resolved?: string }>();
  for (const line of config.split('\n')) {
    const match = /^remote\.(.+)\.(url|gh-resolved) (.+)$/u.exec(line.trim());
    if (match === null) continue;
    const [, remote = '', key, value = ''] = match;
    const entry = remotes.get(remote) ?? {};
    if (key === 'url') entry.url ??= value;
    else entry.resolved = value;
    remotes.set(remote, entry);
  }
  const rank = (remote: string): number => {
    const index = remotePriority.indexOf(remote);
    return index === -1 ? remotePriority.length : index;
  };
  const ordered = [...remotes].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const chosen = ordered.find(([, entry]) => entry.resolved !== undefined);
  if (chosen !== undefined) {
    const remote = chosen[1].url === undefined ? undefined : parseGitRemote(chosen[1].url);
    const [owner, name] = (chosen[1].resolved ?? '').split('/');
    if (remote !== undefined && owner !== undefined && name !== undefined && chosen[1].resolved !== 'base') return { host: remote.host, owner, name };
    if (remote !== undefined) return remote;
  }
  for (const [, entry] of ordered) {
    const remote = entry.url === undefined ? undefined : parseGitRemote(entry.url);
    if (remote !== undefined) return remote;
  }
  return undefined;
}

/** Open PRs by the viewer and requesting the viewer's review, keyed by lowercase `owner/name`. */
type SearchResults = ReadonlyMap<string, { readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }>;

const searchFields = 'number title url isDraft headRefName baseRefName author{login} repository{nameWithOwner} latestReviews(first:20){nodes{state}}';
const searchPages = 10;

/** Group search hits by repository, in the shape `parsePullRequestList` reads. */
export function groupSearchResults(mine: readonly unknown[], reviewRequested: readonly unknown[]): SearchResults {
  const grouped = new Map<string, { mine: unknown[]; reviewRequested: unknown[] }>();
  const add = (node: unknown, list: 'mine' | 'reviewRequested'): void => {
    const record = object(node);
    const repository = object(record['repository'])['nameWithOwner'];
    if (typeof repository !== 'string') return;
    const key = repository.toLowerCase();
    const entry = grouped.get(key) ?? { mine: [], reviewRequested: [] };
    entry[list].push({
      ...record,
      author: record['author'] ?? { login: 'ghost' },
      latestReviews: Array.isArray(object(record['latestReviews'] ?? {})['nodes']) ? object(record['latestReviews'])['nodes'] : [],
    });
    grouped.set(key, entry);
  };
  for (const node of mine) add(node, 'mine');
  for (const node of reviewRequested) add(node, 'reviewRequested');
  return new Map([...grouped].map(([key, entry]) => [key, { mine: parsePullRequestList(entry.mine), reviewRequested: parsePullRequestList(entry.reviewRequested) }]));
}

/** Query pull requests through the user's existing GitHub CLI login. */
export class GitHubCliProvider implements PullRequestProvider {
  /** One search per GitHub host serves every repository's PR lists, instead of two `gh pr list` calls each. */
  static readonly #searches = new Map<string, Promise<SearchResults>>();
  #repository: Promise<{ readonly owner: string; readonly name: string; readonly host: string }> | undefined;
  readonly #ids = new Map<number, Promise<string>>();

  private constructor(private readonly executable: string, private readonly workspaceRoot: string) {}

  /** Connect to the repository GitHub CLI selects for this workspace. */
  static async connect(workspaceRoot: string): Promise<GitHubCliProvider> {
    return new GitHubCliProvider(await findGitHubCli(workspaceRoot), workspaceRoot);
  }

  /** Search again on the next listing. */
  static forgetSearches(): void {
    GitHubCliProvider.#searches.clear();
  }

  /** Read from git remotes like GitHub CLI does, falling back to `gh repo view` for remotes it cannot parse. */
  async readRepository(): Promise<PullRequestRepository> {
    const config = await git(this.workspaceRoot, ['config', '--get-regexp', '^remote\\.']).catch(() => '');
    const remote = pickGitHubRemote(config);
    if (remote !== undefined) return { name: `${remote.owner}/${remote.name}`, url: `https://${remote.host}/${remote.owner}/${remote.name}` };
    return parseRepository(await this.#json(['repo', 'view', '--json', 'nameWithOwner,url']));
  }

  async listMine(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).mine;
  }

  async listReviewRequested(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).reviewRequested;
  }

  async #listed(): Promise<{ readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }> {
    const { owner, name, host } = await this.#repo();
    const key = `${this.executable}\n${host}`;
    let search = GitHubCliProvider.#searches.get(key);
    if (search === undefined) {
      search = this.#search(host);
      search.catch(() => { GitHubCliProvider.#searches.delete(key); });
      GitHubCliProvider.#searches.set(key, search);
    }
    return (await search).get(`${owner}/${name}`.toLowerCase()) ?? { mine: [], reviewRequested: [] };
  }

  async #search(host: string): Promise<SearchResults> {
    const all = async (query: string): Promise<unknown[]> => {
      const nodes: unknown[] = [];
      let after: string | null = null;
      for (let page = 0; page < searchPages; page += 1) {
        const data = await this.#graphqlOn(host, `query($query:String!,$after:String){search(query:$query,type:ISSUE,first:100,after:$after){
          pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${searchFields}}}}}`, { query, after });
        const result = object(data['search']);
        if (Array.isArray(result['nodes'])) nodes.push(...(result['nodes'] as unknown[]).filter((node) => typeof node === 'object' && node !== null && 'number' in node));
        const info = object(result['pageInfo']);
        if (info['hasNextPage'] !== true || typeof info['endCursor'] !== 'string') break;
        after = info['endCursor'];
      }
      return nodes;
    };
    const [mine, reviewRequested] = await Promise.all([
      all('is:pr is:open author:@me sort:created-desc'),
      all('is:pr is:open review-requested:@me sort:created-desc'),
    ]);
    return groupSearchResults(mine, reviewRequested);
  }

  async listFiles(number: number): Promise<readonly PullRequestFile[]> {
    return parsePullRequestFiles(await this.#json(['pr', 'view', String(number), '--json', 'files']));
  }

  async checkout(number: number, worktree: string): Promise<void> {
    await this.#run(['pr', 'checkout', String(number), '--detach'], worktree);
  }

  async viewedFiles(number: number): Promise<ReadonlySet<string>> {
    const viewed = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        files(first:100,after:$after){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`, { number, after });
      const files = object(object(object(data['repository'])['pullRequest'])['files']);
      for (const node of list(files['nodes'])) {
        const record = object(node);
        if (record['viewerViewedState'] === 'VIEWED') viewed.add(text(record['path']));
      }
      const info = object(files['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    return viewed;
  }

  async setViewed(number: number, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await this.#graphql(`mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
      { id: await this.#pullRequestId(number), path });
  }

  async publishComment(number: number, comment: PullRequestComment, pending: boolean): Promise<string> {
    const { lines } = comment;
    const startLine = lines !== undefined && lines.start < lines.end ? lines.start : null;
    if (!pending) {
      const { owner, name } = await this.#repo();
      const body = {
        body: comment.body, commit_id: comment.commitId, path: comment.path,
        ...(lines === undefined ? { subject_type: 'file' } : { side: comment.side, line: lines.end, ...(startLine === null ? {} : { start_line: startLine, start_side: comment.side }) }),
      };
      const created = object(await this.#json(['api', '--hostname', (await this.#repo()).host, '--method', 'POST', `repos/${owner}/${name}/pulls/${number}/comments`, '--input', '-'], JSON.stringify(body)));
      return httpsUrl(created['html_url']);
    }
    const review = await this.#pendingReview(number, comment.commitId);
    const data = await this.#graphql(`mutation($review:ID!,$path:String!,$body:String!,$line:Int,$startLine:Int,$side:DiffSide,$subject:PullRequestReviewThreadSubjectType){
      addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,body:$body,line:$line,startLine:$startLine,side:$side,startSide:$side,subjectType:$subject}){thread{comments(first:1){nodes{url}}}}}`, {
      review, path: comment.path, body: comment.body, line: lines?.end ?? null, startLine,
      side: lines === undefined ? null : comment.side, subject: lines === undefined ? 'FILE' : 'LINE',
    });
    const thread = object(object(data['addPullRequestReviewThread'])['thread']);
    return httpsUrl(object(list(object(thread['comments'])['nodes'])[0])['url']);
  }

  async details(number: number): Promise<PullRequestDetails> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
      pullRequest(number:$number){bodyHTML state mergeable viewerDidAuthor
        reviews(states:PENDING,first:20){nodes{viewerDidAuthor comments{totalCount}}}
        reviewRequests(first:30){nodes{requestedReviewer{... on User{login} ... on Team{name} ... on Bot{login}}}}
        latestOpinionatedReviews(first:30){nodes{state author{login}}}
        commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
          ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}}}`, { number });
    return parseDetails(object(data['repository']));
  }

  async threads(number: number): Promise<readonly RemoteThread[]> {
    const threads: RemoteThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        reviewThreads(first:100,after:$after){nodes{id path diffSide line startLine originalLine originalStartLine isOutdated isResolved
          comments(first:100){nodes{url bodyHTML state author{login avatarUrl(size:40)}}}} pageInfo{hasNextPage endCursor}}}}}`, { number, after });
      const connection = object(object(object(data['repository'])['pullRequest'])['reviewThreads']);
      threads.push(...parseReviewThreads(connection['nodes']));
      const info = object(connection['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    return threads;
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.#graphql('mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}',
      { thread: threadId, body });
  }

  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.#graphql(`mutation($thread:ID!){${mutation}(input:{threadId:$thread}){thread{id}}}`, { thread: threadId });
  }

  async submitReview(number: number, event: ReviewEvent, body: string): Promise<void> {
    const events: Record<ReviewEvent, string> = { approve: 'APPROVE', requestChanges: 'REQUEST_CHANGES', comment: 'COMMENT' };
    const pending = await this.#ownPendingReview(number);
    if (pending !== undefined) {
      await this.#graphql('mutation($review:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$review,event:$event,body:$body}){clientMutationId}}',
        { review: pending, event: events[event], body });
      return;
    }
    await this.#graphql('mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){addPullRequestReview(input:{pullRequestId:$id,event:$event,body:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), event: events[event], body });
  }

  async merge(number: number, method: MergeMethod): Promise<void> {
    await this.#run(['pr', 'merge', String(number), `--${method}`], this.workspaceRoot);
  }

  /** The user's pending review on a PR, started at `commitId` when there is none yet. */
  async #pendingReview(number: number, commitId: string): Promise<string> {
    const own = await this.#ownPendingReview(number);
    if (own !== undefined) return own;
    const created = await this.#graphql('mutation($id:ID!,$commit:GitObjectID){addPullRequestReview(input:{pullRequestId:$id,commitOID:$commit}){pullRequestReview{id}}}',
      { id: await this.#pullRequestId(number), commit: commitId });
    return text(object(object(created['addPullRequestReview'])['pullRequestReview'])['id']);
  }

  async #ownPendingReview(number: number): Promise<string | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviews(states:PENDING,first:20){nodes{id viewerDidAuthor}}}}}`, { number });
    const reviews = list(object(object(object(data['repository'])['pullRequest'])['reviews'])['nodes']).map(object);
    const own = reviews.find((review) => review['viewerDidAuthor'] === true);
    return own === undefined ? undefined : text(own['id']);
  }

  #pullRequestId(number: number): Promise<string> {
    let id = this.#ids.get(number);
    if (id === undefined) {
      id = this.#graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}', { number })
        .then((data) => text(object(object(data['repository'])['pullRequest'])['id']));
      id.catch(() => { this.#ids.delete(number); });
      this.#ids.set(number, id);
    }
    return id;
  }

  #repo(): Promise<{ readonly owner: string; readonly name: string; readonly host: string }> {
    this.#repository ??= this.readRepository().then(({ name, url }) => {
      const [owner = '', repository = ''] = name.split('/');
      return { owner, name: repository, host: new URL(url).host };
    });
    return this.#repository;
  }

  /** Run a GraphQL request for this repository, with the body kept off the command line. */
  async #graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { owner, name, host } = await this.#repo();
    return await this.#graphqlOn(host, query, { owner, name, ...variables });
  }

  async #graphqlOn(host: string, query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const response = object(await this.#json(['api', '--hostname', host, 'graphql', '--input', '-'], JSON.stringify({ query, variables })));
    const errors = response['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const message = (errors as unknown[]).map((error) => (typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined))
        .filter((value): value is string => typeof value === 'string').join(' ');
      throw new Error(`GitHub refused the request.${message ? ` ${message.slice(0, 400)}` : ''}`);
    }
    return object(response['data']);
  }

  /** Parse GitHub CLI output as untrusted JSON. */
  async #json(args: readonly string[], input?: string): Promise<unknown> {
    const output = await this.#run(args, this.workspaceRoot, input);
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error('GitHub CLI returned invalid data.');
    }
  }

  /** Run GitHub CLI without a shell or prompts. */
  #run(args: readonly string[], cwd: string, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
      delete environment['GH_REPO'];
      const child = execFile(this.executable, [...args], {
        cwd, env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error !== null) {
          const detail = [stderr.trim(), apiErrorDetail(stdout)].filter(Boolean).join(' ').slice(0, 600).replaceAll(/(?:gh[pousr]_[A-Za-z\d_]+|github_pat_[A-Za-z\d_]+)/gu, '[credential]');
          reject(new Error(`GitHub CLI failed (gh ${args.slice(0, 2).join(' ')}). Check "gh auth status".${detail ? ` ${detail}` : ''}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
}

/** GitHub's reasons from a failed `gh api` call, which `gh` prints as JSON on stdout. */
export function apiErrorDetail(stdout: string): string {
  try {
    const errors = (JSON.parse(stdout) as { errors?: unknown }).errors;
    if (!Array.isArray(errors)) return '';
    return errors.map((error: unknown) => typeof error === 'string' ? error
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '')
      .filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/** Validate a repository description from `gh repo view`. */
export function parseRepository(value: unknown): PullRequestRepository {
  const record = object(value);
  return { name: text(record['nameWithOwner']), url: httpsUrl(record['url']) };
}

/** Validate a PR list from `gh pr list`, rejecting the whole response on any malformed entry. */
export function parsePullRequestList(value: unknown): readonly PullRequestSummary[] {
  if (!Array.isArray(value)) throw new Error('GitHub CLI returned an invalid PR list.');
  return (value as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const number = record['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub CLI returned an invalid PR number.');
    }
    const reviews = Array.isArray(record['latestReviews']) ? record['latestReviews'] as readonly unknown[] : [];
    const review = strongestVerdict(reviews.map((entry) => String(typeof entry === 'object' && entry !== null ? (entry as { state?: unknown }).state : '')));
    return {
      number,
      title: text(record['title']),
      url: httpsUrl(record['url']),
      author: text(object(record['author'])['login']),
      draft: record['isDraft'] === true,
      headBranch: text(record['headRefName']),
      baseBranch: text(record['baseRefName']),
      ...(review === undefined ? {} : { review }),
    };
  });
}

const changeTypes: Record<string, PullRequestFile['change']> = {
  ADDED: 'added', MODIFIED: 'modified', DELETED: 'deleted', RENAMED: 'renamed', CHANGED: 'modified', COPIED: 'added',
};

/** Validate the file list from `gh pr view --json files`, rejecting paths that leave the repository. */
export function parsePullRequestFiles(value: unknown): readonly PullRequestFile[] {
  const files = object(value)['files'];
  if (!Array.isArray(files)) throw new Error('GitHub CLI returned an invalid file list.');
  return (files as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const path = text(record['path']);
    const additions = record['additions'];
    const deletions = record['deletions'];
    const change = changeTypes[String(record['changeType'])] ?? 'modified';
    if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')
      || typeof additions !== 'number' || typeof deletions !== 'number') {
      throw new Error('GitHub CLI returned an invalid file entry.');
    }
    return { path, additions, deletions, change };
  });
}

const reviewStates: Record<string, PullRequestDetails['reviewers'][number]['state']> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed',
};

/** Map a check run conclusion or commit status to one of four states. */
function checkState(raw: unknown): PullRequestDetails['checks'][number]['state'] {
  const value = String(raw);
  if (value === 'SUCCESS') return 'success';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) return 'failure';
  if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(value)) return 'neutral';
  return 'pending';
}

/** Validate PR details from GraphQL; reviewers without an account and malformed checks are left out. */
export function parseDetails(repository: Record<string, unknown>): PullRequestDetails {
  const pullRequest = object(repository['pullRequest']);
  const methods: readonly [string, MergeMethod][] = [['squashMergeAllowed', 'squash'], ['mergeCommitAllowed', 'merge'], ['rebaseMergeAllowed', 'rebase']];
  const reviewers: PullRequestDetails['reviewers'][number][] = [];
  for (const node of list(object(pullRequest['latestOpinionatedReviews'])['nodes'])) {
    const review = object(node);
    const login = typeof review['author'] === 'object' && review['author'] !== null ? (review['author'] as { login?: unknown }).login : undefined;
    const state = reviewStates[String(review['state'])];
    if (typeof login === 'string' && state !== undefined) reviewers.push({ name: login, state });
  }
  for (const node of list(object(pullRequest['reviewRequests'])['nodes'])) {
    const reviewer = object(node)['requestedReviewer'];
    const record = typeof reviewer === 'object' && reviewer !== null ? reviewer as { login?: unknown; name?: unknown } : {};
    const name = record.login ?? record.name;
    if (typeof name === 'string' && !reviewers.some((entry) => entry.name === name)) reviewers.push({ name, state: 'requested' });
  }
  const commit = list(object(pullRequest['commits'])['nodes'])[0];
  const rollup = commit === undefined ? null : object(object(commit)['commit'])['statusCheckRollup'];
  const checks: PullRequestDetails['checks'][number][] = [];
  if (typeof rollup === 'object' && rollup !== null) {
    for (const node of list(object((rollup as Record<string, unknown>)['contexts'])['nodes'])) {
      const check = object(node);
      const run = check['__typename'] === 'CheckRun';
      const name = run ? check['name'] : check['context'];
      const link = run ? check['detailsUrl'] : check['targetUrl'];
      if (typeof name !== 'string') continue;
      const url = typeof link === 'string' && link.startsWith('https://') ? link : undefined;
      checks.push({ name, state: checkState(run ? (check['status'] === 'COMPLETED' ? check['conclusion'] : 'PENDING') : check['state']), ...(url === undefined ? {} : { url }) });
    }
  }
  const pending = pullRequest['reviews'] === undefined ? undefined
    : list(object(pullRequest['reviews'])['nodes']).map(object).find((review) => review['viewerDidAuthor'] === true);
  const pendingComments = pending === undefined ? undefined : object(pending['comments'])['totalCount'];
  return {
    ...(typeof pendingComments === 'number' ? { pendingComments } : {}),
    bodyHtml: typeof pullRequest['bodyHTML'] === 'string' ? pullRequest['bodyHTML'] : '',
    open: pullRequest['state'] === 'OPEN',
    mergeable: pullRequest['mergeable'] === 'MERGEABLE' ? 'yes' : pullRequest['mergeable'] === 'CONFLICTING' ? 'no' : 'unknown',
    viewerIsAuthor: pullRequest['viewerDidAuthor'] === true,
    mergeMethods: methods.filter(([key]) => repository[key] === true).map(([, method]) => method),
    reviewers,
    checks,
  };
}

/** Read review threads, skipping file-level ones and threads whose comments are all gone. */
export function parseReviewThreads(nodes: unknown): readonly RemoteThread[] {
  const threads: RemoteThread[] = [];
  for (const node of list(nodes)) {
    const thread = object(node);
    const outdated = thread['isOutdated'] === true;
    const endLine = outdated ? thread['originalLine'] : thread['line'];
    const startLine = (outdated ? thread['originalStartLine'] : thread['startLine']) ?? endLine;
    const comments = list(object(thread['comments'])['nodes']).map(object);
    if (!Number.isSafeInteger(endLine) || !Number.isSafeInteger(startLine) || comments.length === 0) continue;
    threads.push({
      id: text(thread['id']),
      path: text(thread['path']),
      side: thread['diffSide'] === 'LEFT' ? 'LEFT' : 'RIGHT',
      startLine: startLine as number,
      endLine: endLine as number,
      outdated,
      resolved: thread['isResolved'] === true,
      pending: comments[0]?.['state'] === 'PENDING',
      url: httpsUrl(comments[0]?.['url']),
      comments: comments.map((comment) => {
        const author = comment['author'] === null ? {} : object(comment['author']);
        return {
          author: typeof author['login'] === 'string' ? author['login'] : 'ghost',
          avatarUrl: optionalHttpsUrl(author['avatarUrl']),
          pending: comment['state'] === 'PENDING',
          bodyHtml: typeof comment['bodyHTML'] === 'string' ? comment['bodyHTML'] : '',
        };
      }),
    });
  }
  return threads;
}

/** Narrow an untrusted CLI value to a plain object. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GitHub CLI returned incomplete data.');
  return value as Record<string, unknown>;
}

/** Narrow an untrusted CLI value to an array. */
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub CLI returned incomplete data.');
  return value as readonly unknown[];
}

/** Require a non-empty string without coercion. */
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GitHub CLI returned incomplete data.');
  return value;
}

/** Accept only credential-free HTTPS links for browser navigation. */
/** A link GitHub may leave out, such as a deleted user's avatar; empty when missing or not https. */
function optionalHttpsUrl(value: unknown): string {
  try {
    return httpsUrl(value);
  } catch {
    return '';
  }
}

function httpsUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('GitHub CLI returned an invalid link.');
  return url.toString();
}
