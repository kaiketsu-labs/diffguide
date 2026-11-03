import { endpointsFor, githubRequest } from './githubApi.js';
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
  readonly title: string;
  /** The description as Markdown, for editing. */
  readonly body: string;
  readonly open: boolean;
  readonly merged: boolean;
  readonly draft: boolean;
  /** The viewer may edit the PR: title, description, labels, assignees, reviewers, draft and open state. */
  readonly canEdit: boolean;
  /** The head branch lives in this repository, still exists and GitHub does not delete it on merge. */
  readonly branchDeletable: boolean;
  readonly labels: readonly Label[];
  readonly assignees: readonly string[];
  readonly mergeable: 'yes' | 'no' | 'unknown';
  readonly viewerIsAuthor: boolean;
  /** Comments in the viewer's unsubmitted review; undefined when there is no such review. */
  readonly pendingComments?: number;
  readonly mergeMethods: readonly MergeMethod[];
  /** `team` holds the team's slug for a requested team. */
  readonly reviewers: readonly { readonly name: string; readonly state: 'requested' | 'approved' | 'changes' | 'commented' | 'dismissed'; readonly team?: string }[];
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
  /** `canDelete` when the viewer may delete the comment, usually because they wrote it. */
  readonly comments: readonly { readonly id: string; readonly author: string; readonly avatarUrl: string; readonly pending: boolean; readonly bodyHtml: string; readonly canDelete: boolean }[];
}

export interface Label { readonly name: string; readonly color: string }

/** Who can be asked to review, assigned or labeled on this repository. */
export interface PickerOptions {
  readonly users: readonly string[];
  readonly teams: readonly { readonly name: string; readonly slug: string }[];
  readonly labels: readonly Label[];
}

/** Users by login and teams by slug. */
export interface ReviewerSet { readonly users: readonly string[]; readonly teams: readonly string[] }

/** Fields to change on a PR; `labels` and `assignees` replace the current lists. */
export interface PullRequestEdit {
  readonly title?: string;
  readonly body?: string;
  readonly state?: 'open' | 'closed';
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
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
  /** Details and review threads together, in as few requests as the code host allows. */
  overview(number: number): Promise<{ readonly details: PullRequestDetails; readonly threads: readonly RemoteThread[] }>;
  /** Post a reply to a code host thread right away, visible to everyone. */
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  /** Delete one review comment; deleting a thread's only comment removes the thread. */
  deleteComment(commentId: string): Promise<void>;
  /** Submit the user's review, including comments already in their pending review. */
  submitReview(number: number, event: ReviewEvent, body: string): Promise<void>;
  merge(number: number, method: MergeMethod): Promise<void>;
  editPullRequest(number: number, edit: PullRequestEdit): Promise<void>;
  setDraft(number: number, draft: boolean): Promise<void>;
  requestReviewers(number: number, reviewers: ReviewerSet): Promise<void>;
  removeReviewers(number: number, reviewers: ReviewerSet): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  pickerOptions(): Promise<PickerOptions>;
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
const mergeMethodFields = 'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge';
const detailsFields = `bodyHTML body title state isDraft mergeable viewerDidAuthor viewerCanUpdate isCrossRepository headRef{id}
  labels(first:50){nodes{name color}} assignees(first:20){nodes{login}}
  reviews(states:PENDING,first:20){nodes{viewerDidAuthor comments{totalCount}}}
  reviewRequests(first:30){nodes{requestedReviewer{... on User{login} ... on Team{name slug} ... on Bot{login}}}}
  latestOpinionatedReviews(first:30){nodes{state author{login}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}`;
const threadsField = `reviewThreads(first:100,after:$after){nodes{id path diffSide line startLine originalLine originalStartLine isOutdated isResolved
  comments(first:100){nodes{id viewerCanDelete url bodyHTML state author{login avatarUrl(size:40)}}}} pageInfo{hasNextPage endCursor}}`;

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

/** Query pull requests through the user's GitHub sign-in in VS Code. */
export class GitHubApiProvider implements PullRequestProvider {
  /** One search per GitHub host serves every repository's PR lists. */
  static readonly #searches = new Map<string, Promise<SearchResults>>();
  /** One provider per repository keeps its remotes, PR ids and Viewed flags until `forget`. */
  static readonly #providers = new Map<string, GitHubApiProvider>();
  #repository: Promise<{ readonly owner: string; readonly name: string; readonly host: string }> | undefined;
  #remotes: Promise<string> | undefined;
  readonly #ids = new Map<number, Promise<string>>();
  /** Viewed flags from the latest file list of each PR, so reading them needs no second request. */
  readonly #viewed = new Map<number, ReadonlySet<string>>();

  private constructor(private readonly workspaceRoot: string) {}

  /** Connect to the repository the workspace's git remotes point to. */
  static async connect(workspaceRoot: string): Promise<GitHubApiProvider> {
    let provider = GitHubApiProvider.#providers.get(workspaceRoot);
    if (provider === undefined) GitHubApiProvider.#providers.set(workspaceRoot, provider = new GitHubApiProvider(workspaceRoot));
    return provider;
  }

  /** Search again and re-read remotes on the next listing. */
  static forget(): void {
    GitHubApiProvider.#searches.clear();
    GitHubApiProvider.#providers.clear();
  }

  /** Read from git remotes the way GitHub CLI picks its repository. */
  async readRepository(): Promise<PullRequestRepository> {
    const remote = pickGitHubRemote(await this.#remoteConfig());
    if (remote === undefined) throw new Error('No GitHub remote found in this repository.');
    return { name: `${remote.owner}/${remote.name}`, url: `https://${remote.host}/${remote.owner}/${remote.name}` };
  }

  async listMine(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).mine;
  }

  async listReviewRequested(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).reviewRequested;
  }

  async #listed(): Promise<{ readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }> {
    const { owner, name, host } = await this.#repo();
    let search = GitHubApiProvider.#searches.get(host);
    if (search === undefined) {
      search = this.#search(host);
      search.catch(() => { GitHubApiProvider.#searches.delete(host); });
      GitHubApiProvider.#searches.set(host, search);
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
    const files: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        files(first:100,after:$after){nodes{path additions deletions changeType viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`, { number, after });
      const connection = object(object(object(data['repository'])['pullRequest'])['files']);
      files.push(...list(connection['nodes']));
      const info = object(connection['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    const parsed = parsePullRequestFiles({ files });
    this.#viewed.set(number, new Set(files.map(object).filter((file) => file['viewerViewedState'] === 'VIEWED').map((file) => text(file['path']))));
    return parsed;
  }

  /** Fetch GitHub's `pull/<n>/head` ref, which also covers PRs from forks, through the user's git credentials. */
  async checkout(number: number, worktree: string): Promise<void> {
    const { owner, name, host } = await this.#repo();
    const remote = remoteNameFor(await this.#remoteConfig(), { host, owner, name }) ?? `https://${host}/${owner}/${name}.git`;
    await git(worktree, ['fetch', '--quiet', remote, `pull/${number}/head`]);
    await git(worktree, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }

  async viewedFiles(number: number): Promise<ReadonlySet<string>> {
    const listed = this.#viewed.get(number);
    if (listed !== undefined) return listed;
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
    this.#viewed.delete(number);
    await this.#graphql(`mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
      { id: await this.#pullRequestId(number), path });
  }

  async publishComment(number: number, comment: PullRequestComment, pending: boolean): Promise<string> {
    const { lines } = comment;
    const startLine = lines !== undefined && lines.start < lines.end ? lines.start : null;
    if (!pending) {
      const { owner, name, host } = await this.#repo();
      const body = {
        body: comment.body, commit_id: comment.commitId, path: comment.path,
        ...(lines === undefined ? { subject_type: 'file' } : { side: comment.side, line: lines.end, ...(startLine === null ? {} : { start_line: startLine, start_side: comment.side }) }),
      };
      const endpoints = endpointsFor(host);
      const created = object(await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/pulls/${number}/comments`, 'POST', body));
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
      ${mergeMethodFields} pullRequest(number:$number){${detailsFields}}}}`, { number });
    return parseDetails(object(data['repository']));
  }

  async threads(number: number): Promise<readonly RemoteThread[]> {
    return await this.#threads(number);
  }

  async overview(number: number): Promise<{ readonly details: PullRequestDetails; readonly threads: readonly RemoteThread[] }> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      ${mergeMethodFields} pullRequest(number:$number){id ${detailsFields} ${threadsField}}}}`, { number, after: null });
    const repository = object(data['repository']);
    const id = object(repository['pullRequest'])['id'];
    if (typeof id === 'string' && id !== '') this.#ids.set(number, Promise.resolve(id));
    return { details: parseDetails(repository), threads: await this.#threads(number, data) };
  }

  /** All review threads, continuing from an already fetched first page when given. */
  async #threads(number: number, firstPage?: Record<string, unknown>): Promise<readonly RemoteThread[]> {
    const threads: RemoteThread[] = [];
    let after: string | null = null;
    let data = firstPage;
    for (let page = 0; page < 30; page++) {
      data ??= await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        ${threadsField}}}}`, { number, after });
      const connection = object(object(object(data['repository'])['pullRequest'])['reviewThreads']);
      threads.push(...parseReviewThreads(connection['nodes']));
      const info = object(connection['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
      data = undefined;
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

  async deleteComment(commentId: string): Promise<void> {
    await this.#graphql('mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}', { id: commentId });
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
    const methods: Record<MergeMethod, string> = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };
    await this.#graphql('mutation($id:ID!,$method:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$method}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: methods[method] });
  }

  async editPullRequest(number: number, edit: PullRequestEdit): Promise<void> {
    await this.#rest(`issues/${number}`, 'PATCH', edit);
  }

  async setDraft(number: number, draft: boolean): Promise<void> {
    const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    await this.#graphql(`mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){clientMutationId}}`, { id: await this.#pullRequestId(number) });
  }

  async requestReviewers(number: number, reviewers: ReviewerSet): Promise<void> {
    await this.#rest(`pulls/${number}/requested_reviewers`, 'POST', { reviewers: reviewers.users, team_reviewers: reviewers.teams });
  }

  async removeReviewers(number: number, reviewers: ReviewerSet): Promise<void> {
    await this.#rest(`pulls/${number}/requested_reviewers`, 'DELETE', { reviewers: reviewers.users, team_reviewers: reviewers.teams });
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.#rest(`git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'DELETE');
  }

  async pickerOptions(): Promise<PickerOptions> {
    const data = await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
      assignableUsers(first:100){nodes{login}} labels(first:100){nodes{name color}}
      owner{... on Organization{teams(first:100){nodes{name slug}}}}}}`, {});
    return parsePickerOptions(object(data['repository']));
  }

  /** Call a REST endpoint under this repository. */
  async #rest(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<unknown> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, method, body);
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

  /** Remote lines from git config, read once per provider. */
  #remoteConfig(): Promise<string> {
    this.#remotes ??= git(this.workspaceRoot, ['config', '--get-regexp', '^remote\\.']).catch(() => '');
    return this.#remotes;
  }

  /** Run a GraphQL request for this repository. */
  async #graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { owner, name, host } = await this.#repo();
    return await this.#graphqlOn(host, query, { owner, name, ...variables });
  }

  async #graphqlOn(host: string, query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const endpoints = endpointsFor(host);
    const response = object(await githubRequest(endpoints, endpoints.graphql, 'POST', { query, variables }));
    const errors = response['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const message = (errors as unknown[]).map((error) => (typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined))
        .filter((value): value is string => typeof value === 'string').join(' ');
      throw new Error(`GitHub refused the request.${message ? ` ${message.slice(0, 400)}` : ''}`);
    }
    return object(response['data']);
  }
}

/** The git remote that points at `repository`, usable as a fetch source; undefined when none does. */
export function remoteNameFor(config: string, repository: GitHubRemote): string | undefined {
  for (const line of config.split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/u.exec(line.trim());
    const remote = match?.[2] === undefined ? undefined : parseGitRemote(match[2]);
    if (match?.[1] === undefined || match[1].startsWith('-') || remote === undefined) continue;
    if (remote.host === repository.host && remote.owner.toLowerCase() === repository.owner.toLowerCase()
      && remote.name.toLowerCase() === repository.name.toLowerCase()) return match[1];
  }
  return undefined;
}

/** Validate a PR list from a GitHub search, rejecting the whole response on any malformed entry. */
export function parsePullRequestList(value: unknown): readonly PullRequestSummary[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid PR list.');
  return (value as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const number = record['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub returned an invalid PR number.');
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

/** Validate a PR's changed files, rejecting paths that leave the repository. */
export function parsePullRequestFiles(value: unknown): readonly PullRequestFile[] {
  const files = object(value)['files'];
  if (!Array.isArray(files)) throw new Error('GitHub returned an invalid file list.');
  return (files as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const path = text(record['path']);
    const additions = record['additions'];
    const deletions = record['deletions'];
    const change = changeTypes[String(record['changeType'])] ?? 'modified';
    if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')
      || typeof additions !== 'number' || typeof deletions !== 'number') {
      throw new Error('GitHub returned an invalid file entry.');
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
    const record = typeof reviewer === 'object' && reviewer !== null ? reviewer as { login?: unknown; name?: unknown; slug?: unknown } : {};
    const name = record.login ?? record.name;
    if (typeof name !== 'string' || reviewers.some((entry) => entry.name === name)) continue;
    reviewers.push({ name, state: 'requested', ...(typeof record.slug === 'string' ? { team: record.slug } : {}) });
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
    title: typeof pullRequest['title'] === 'string' ? pullRequest['title'] : '',
    body: typeof pullRequest['body'] === 'string' ? pullRequest['body'] : '',
    open: pullRequest['state'] === 'OPEN',
    merged: pullRequest['state'] === 'MERGED',
    draft: pullRequest['isDraft'] === true,
    canEdit: pullRequest['viewerCanUpdate'] === true,
    branchDeletable: pullRequest['isCrossRepository'] === false && pullRequest['headRef'] !== null && pullRequest['headRef'] !== undefined && repository['deleteBranchOnMerge'] !== true,
    labels: parseLabels(pullRequest['labels']),
    assignees: logins(pullRequest['assignees']),
    mergeable: pullRequest['mergeable'] === 'MERGEABLE' ? 'yes' : pullRequest['mergeable'] === 'CONFLICTING' ? 'no' : 'unknown',
    viewerIsAuthor: pullRequest['viewerDidAuthor'] === true,
    mergeMethods: methods.filter(([key]) => repository[key] === true).map(([, method]) => method),
    reviewers,
    checks,
  };
}

function logins(connection: unknown): readonly string[] {
  return list(object(connection)['nodes']).map((node) => object(node)['login']).filter((login): login is string => typeof login === 'string');
}

/** Labels with a six-digit hex color; others are left out. */
function parseLabels(connection: unknown): readonly Label[] {
  return list(object(connection)['nodes']).map(object).flatMap((label) => {
    const { name, color } = label;
    return typeof name === 'string' && typeof color === 'string' && /^[0-9a-f]{6}$/iu.test(color) ? [{ name, color }] : [];
  });
}

/** Users, teams and labels for the reviewer, assignee and label pickers; a repository owned by a user has no teams. */
export function parsePickerOptions(repository: Record<string, unknown>): PickerOptions {
  const owner = repository['owner'];
  const teams = typeof owner === 'object' && owner !== null && 'teams' in owner ? list(object((owner as Record<string, unknown>)['teams'])['nodes']).map(object) : [];
  return {
    users: logins(repository['assignableUsers']),
    teams: teams.flatMap(({ name, slug }) => typeof name === 'string' && typeof slug === 'string' ? [{ name, slug }] : []),
    labels: parseLabels(repository['labels']),
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
          id: text(comment['id']),
          author: typeof author['login'] === 'string' ? author['login'] : 'ghost',
          avatarUrl: optionalHttpsUrl(author['avatarUrl']),
          pending: comment['state'] === 'PENDING',
          bodyHtml: typeof comment['bodyHTML'] === 'string' ? comment['bodyHTML'] : '',
          canDelete: comment['viewerCanDelete'] === true,
        };
      }),
    });
  }
  return threads;
}

/** Narrow an untrusted CLI value to a plain object. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as Record<string, unknown>;
}

/** Narrow an untrusted CLI value to an array. */
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as readonly unknown[];
}

/** Require a non-empty string without coercion. */
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GitHub returned incomplete data.');
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
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('GitHub returned an invalid link.');
  return url.toString();
}
