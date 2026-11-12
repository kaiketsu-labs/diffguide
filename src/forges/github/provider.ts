import type { ChangeRequestComment, ChangeRequestConversation, ChangeRequestDetails, ChangeRequestEdit, ChangeRequestFile, ChangeRequestSummary, ChangeRequestVersion, CommentKind, Forge, ForgeRepository, LinkedChangeRequestState, ListVersion, MergeMessage, MergeMethod, PickerOptions, Polled, ReactionContent, RemoteThread, ReviewerSet, ReviewEvent } from '../../core/forge.js';
import { git } from '../../core/git/worktrees.js';
import { endpointsFor, githubPoll, githubRequest } from './githubApi.js';
import { canWrite, httpsUrl, list, object, parseConversation, parseDetails, parseLinkedState, parsePickerOptions, parsePullRequestFiles, parsePullRequestList, parseReviewThreads, searchNode, text } from './parse.js';
import { type GitHubRemote, parseGitRemote, pickGitHubRemote } from './remotes.js';

const graphqlMethods: Record<MergeMethod, string> = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };

/** Open PRs by the viewer and requesting the viewer's review, keyed by lowercase `owner/name`. */
type SearchResults = ReadonlyMap<string, { readonly mine: readonly ChangeRequestSummary[]; readonly reviewRequested: readonly ChangeRequestSummary[] }>;

const searchFields = 'number title url isDraft headRefName headRefOid baseRefName createdAt updatedAt additions deletions changedFiles author{login} repository{nameWithOwner} latestReviews(first:20){nodes{state}} '
  + 'reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name} ... on Bot{login} ... on Mannequin{login}}}}';
const searchPages = 10;
const mergeMethodFields = 'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge';
const viewerField = 'viewer{login name avatarUrl(size:40)}';
const detailsFields = `bodyHTML body title state isDraft mergeable viewerDidAuthor viewerCanUpdate isCrossRepository headRef{id} headRepository{nameWithOwner} author{login}
  labels(first:50){nodes{name color}} assignees(first:20){nodes{login}} milestone{number title}
  reviews(states:PENDING,first:20){nodes{viewerDidAuthor comments{totalCount}}}
  reviewRequests(first:30){nodes{requestedReviewer{... on User{login} ... on Team{name slug} ... on Bot{login}}}}
  latestOpinionatedReviews(first:30){nodes{state author{login}}}
  latestReviews(first:30){nodes{state author{login}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}`;
const reactionFields = 'reactionGroups{content viewerHasReacted reactors{totalCount}}';
const commentFields = `id url body bodyHTML createdAt lastEditedAt viewerCanUpdate viewerCanDelete viewerCanMinimize viewerCanReact isMinimized minimizedReason
  author{login avatarUrl(size:40) ... on User{name}} ${reactionFields}`;
const threadsField = `reviewThreads(first:100,after:$after){nodes{id path diffSide line startLine originalLine originalStartLine isOutdated isResolved subjectType
  comments(first:100){nodes{${commentFields} state diffHunk}}} pageInfo{hasNextPage endCursor}}`;
const actorField = 'actor{login avatarUrl(size:40)}';
const userLogin = '... on User{login} ... on Bot{login} ... on Mannequin{login}';
const timelineTypes = ['ISSUE_COMMENT', 'PULL_REQUEST_REVIEW', 'PULL_REQUEST_COMMIT', 'HEAD_REF_FORCE_PUSHED_EVENT', 'LABELED_EVENT', 'UNLABELED_EVENT',
  'REVIEW_REQUESTED_EVENT', 'REVIEW_REQUEST_REMOVED_EVENT', 'REVIEW_DISMISSED_EVENT', 'MERGED_EVENT', 'CLOSED_EVENT', 'REOPENED_EVENT', 'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT', 'ASSIGNED_EVENT', 'UNASSIGNED_EVENT', 'RENAMED_TITLE_EVENT', 'BASE_REF_CHANGED_EVENT', 'HEAD_REF_DELETED_EVENT', 'HEAD_REF_RESTORED_EVENT',
  'CROSS_REFERENCED_EVENT', 'AUTO_MERGE_ENABLED_EVENT', 'AUTO_MERGE_DISABLED_EVENT', 'MILESTONED_EVENT', 'DEMILESTONED_EVENT'].join(',');
const timelineField = `timelineItems(first:100,after:$after,itemTypes:[${timelineTypes}]){pageInfo{hasNextPage endCursor} nodes{__typename
  ... on IssueComment{${commentFields}}
  ... on PullRequestReview{${commentFields} state submittedAt commit{oid} comments(first:100){nodes{id}}}
  ... on PullRequestCommit{id pushed:commit{oid messageHeadline messageBody committedDate additions deletions changedFilesIfAvailable statusCheckRollup{state} author{name avatarUrl(size:40) user{login}}}}
  ... on HeadRefForcePushedEvent{id createdAt ${actorField} beforeCommit{abbreviatedOid} afterCommit{abbreviatedOid}}
  ... on LabeledEvent{id createdAt ${actorField} label{name}}
  ... on UnlabeledEvent{id createdAt ${actorField} label{name}}
  ... on ReviewRequestedEvent{id createdAt ${actorField} requestedReviewer{${userLogin} ... on Team{name}}}
  ... on ReviewRequestRemovedEvent{id createdAt ${actorField} requestedReviewer{${userLogin} ... on Team{name}}}
  ... on ReviewDismissedEvent{id createdAt ${actorField} review{author{login}}}
  ... on MergedEvent{id createdAt ${actorField} commit{abbreviatedOid} mergeRefName}
  ... on ClosedEvent{id createdAt ${actorField}}
  ... on ReopenedEvent{id createdAt ${actorField}}
  ... on ReadyForReviewEvent{id createdAt ${actorField}}
  ... on ConvertToDraftEvent{id createdAt ${actorField}}
  ... on AssignedEvent{id createdAt ${actorField} assignee{${userLogin}}}
  ... on UnassignedEvent{id createdAt ${actorField} assignee{${userLogin}}}
  ... on RenamedTitleEvent{id createdAt ${actorField} previousTitle currentTitle}
  ... on BaseRefChangedEvent{id createdAt ${actorField} previousRefName currentRefName}
  ... on HeadRefDeletedEvent{id createdAt ${actorField} headRefName}
  ... on HeadRefRestoredEvent{id createdAt ${actorField}}
  ... on CrossReferencedEvent{id createdAt ${actorField} willCloseTarget source{... on Issue{number title repository{nameWithOwner}} ... on PullRequest{number title repository{nameWithOwner}}}}
  ... on AutoMergeEnabledEvent{id createdAt ${actorField}}
  ... on AutoMergeDisabledEvent{id createdAt ${actorField}}
  ... on MilestonedEvent{id createdAt ${actorField} milestoneTitle}
  ... on DemilestonedEvent{id createdAt ${actorField} milestoneTitle}}}`;
/** `latestOpinionatedReviews` comes first: after `reviewDecision`, GitHub lists only reviews by people with write access. */
const conversationFields = `viewerPermission autoMergeAllowed squashMergeCommitTitle squashMergeCommitMessage mergeCommitTitle mergeCommitMessage pullRequest(number:$number){
  latestOpinionatedReviews(first:30){nodes{id author{login}}}
  id viewerCanReact ${reactionFields} mergeStateStatus reviewDecision viewerCanUpdateBranch viewerCanMergeAsAdmin viewerCanEnableAutoMerge viewerCanDisableAutoMerge
  isMergeQueueEnabled mergeQueueEntry{position} headRefOid headRef{id} isCrossRepository autoMergeRequest{mergeMethod enabledBy{login}}
  closingIssuesReferences(first:10){nodes{number title url state}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name isRequired(pullRequestNumber:$number) checkSuite{workflowRun{databaseId}} annotations(first:50){nodes{path annotationLevel title message location{start{line} end{line}}}}}
    ... on StatusContext{context isRequired(pullRequestNumber:$number)}}}}}}}
  ${timelineField}}`;

/** Group search hits by repository, in the shape `parsePullRequestList` reads; with the viewer's login, review requests say whether they came to the viewer or a team. */
export function groupSearchResults(mine: readonly unknown[], reviewRequested: readonly unknown[], viewer?: string): SearchResults {
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
  const via = (pullRequest: ChangeRequestSummary): ChangeRequestSummary => {
    const reviewers = pullRequest.requestedReviewers ?? [];
    const requestedVia = viewer !== undefined && reviewers.some((reviewer) => !reviewer.team && reviewer.name.toLowerCase() === viewer.toLowerCase()) ? 'you'
      : reviewers.some((reviewer) => reviewer.team) ? 'team' : undefined;
    return requestedVia === undefined ? pullRequest : { ...pullRequest, requestedVia };
  };
  return new Map([...grouped].map(([key, entry]) => [key, { mine: parsePullRequestList(entry.mine), reviewRequested: parsePullRequestList(entry.reviewRequested).map(via) }]));
}

/** Query pull requests through the user's GitHub sign-in in VS Code. */
export class GitHubApiProvider implements Forge {
  /** One search per GitHub host serves every repository's PR lists. */
  static readonly #searches = new Map<string, Promise<SearchResults>>();
  /** One provider per repository keeps its remotes, PR ids and Viewed flags until `forget`. */
  static readonly #providers = new Map<string, GitHubApiProvider>();
  #repository: Promise<{ readonly owner: string; readonly name: string; readonly host: string }> | undefined;
  #renamed: Promise<string> | undefined;
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
  async readRepository(): Promise<ForgeRepository> {
    const remote = pickGitHubRemote(await this.#remoteConfig());
    if (remote === undefined) throw new Error('No GitHub remote found in this repository.');
    return { name: `${remote.owner}/${remote.name}`, url: `https://${remote.host}/${remote.owner}/${remote.name}` };
  }

  async listMine(): Promise<readonly ChangeRequestSummary[]> {
    return (await this.#listed()).mine;
  }

  async listReviewRequested(): Promise<readonly ChangeRequestSummary[]> {
    return (await this.#listed()).reviewRequested;
  }

  async #listed(): Promise<{ readonly mine: readonly ChangeRequestSummary[]; readonly reviewRequested: readonly ChangeRequestSummary[] }> {
    const { owner, name, host } = await this.#repo();
    let search = GitHubApiProvider.#searches.get(host);
    if (search === undefined) {
      search = this.#search(host);
      search.catch(() => { GitHubApiProvider.#searches.delete(host); });
      GitHubApiProvider.#searches.set(host, search);
    }
    const results = await search;
    return results.get(`${owner}/${name}`.toLowerCase()) ?? results.get(await this.#currentName()) ?? { mine: [], reviewRequested: [] };
  }

  /** The repository's name on GitHub now, which search reports, when the remote still uses a name from before a rename or transfer. */
  #currentName(): Promise<string> {
    this.#renamed ??= this.#graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}', {})
      .then((data) => text(object(data['repository'])['nameWithOwner']).toLowerCase())
      .catch(() => '');
    return this.#renamed;
  }

  async #search(host: string): Promise<SearchResults> {
    let viewer: string | undefined;
    const all = async (query: string): Promise<unknown[]> => {
      const nodes: unknown[] = [];
      let after: string | null = null;
      for (let page = 0; page < searchPages; page += 1) {
        const data = await this.#graphqlOn(host, `query($query:String!,$after:String){viewer{login} search(query:$query,type:ISSUE,first:100,after:$after){
          pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${searchFields}}}}}`, { query, after });
        const login = object(data['viewer'] ?? {})['login'];
        if (typeof login === 'string') viewer = login;
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
    return groupSearchResults(mine, reviewRequested, viewer);
  }

  async listFiles(number: number): Promise<readonly ChangeRequestFile[]> {
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

  async publishComment(number: number, comment: ChangeRequestComment, pending: boolean): Promise<string> {
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

  async details(number: number): Promise<ChangeRequestDetails> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){${viewerField} repository(owner:$owner,name:$name){
      ${mergeMethodFields} pullRequest(number:$number){${detailsFields}}}}`, { number });
    return parseDetails(object(data['repository']), object(data['viewer']));
  }

  async threads(number: number): Promise<readonly RemoteThread[]> {
    return await this.#threads(number);
  }

  async overview(number: number): Promise<{ readonly details: ChangeRequestDetails; readonly threads: readonly RemoteThread[] }> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){${viewerField} repository(owner:$owner,name:$name){
      ${mergeMethodFields} pullRequest(number:$number){id ${detailsFields} ${threadsField}}}}`, { number, after: null });
    const repository = object(data['repository']);
    const id = object(repository['pullRequest'])['id'];
    if (typeof id === 'string' && id !== '') this.#ids.set(number, Promise.resolve(id));
    return { details: parseDetails(repository, object(data['viewer'])), threads: await this.#threads(number, data) };
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

  async merge(number: number, method: MergeMethod, message: MergeMessage = {}): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestMergeMethod!,$headline:String,$body:String){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$method,commitHeadline:$headline,commitBody:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: graphqlMethods[method], headline: message.headline ?? null, body: message.body ?? null });
  }

  async editPullRequest(number: number, edit: ChangeRequestEdit): Promise<void> {
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
      assignableUsers(first:100){nodes{login}} labels(first:100){nodes{name color description}} milestones(first:50,states:OPEN){nodes{number title}}
      owner{... on Organization{teams(first:100){nodes{name slug}}}}}}`, {});
    return parsePickerOptions(object(data['repository']));
  }

  async search(query: string): Promise<readonly ChangeRequestSummary[]> {
    const { owner, name, host } = await this.#repo();
    const data = await this.#graphqlOn(host, `query($query:String!){search(query:$query,type:ISSUE,first:50){nodes{... on PullRequest{${searchFields}}}}}`,
      { query: `repo:${owner}/${name} is:pr ${query}` });
    const nodes = list(object(data['search'])['nodes']).filter((node) => typeof node === 'object' && node !== null && 'number' in node);
    return parsePullRequestList(nodes.map(searchNode));
  }

  async openCount(): Promise<number> {
    const { owner, name, host } = await this.#repo();
    const data = await this.#graphqlOn(host, 'query($query:String!){search(query:$query,type:ISSUE,first:0){issueCount}}', { query: `repo:${owner}/${name} is:pr is:open` });
    const count = object(data['search'])['issueCount'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('GitHub returned an invalid PR count.');
    return count;
  }

  async openPullRequests(numbers: readonly number[]): Promise<readonly ChangeRequestSummary[]> {
    const valid = numbers.filter((number) => Number.isSafeInteger(number) && number > 0);
    if (valid.length === 0) return [];
    const fields = valid.map((number) => `pr${number}:pullRequest(number:${number}){state ${searchFields}}`).join(' ');
    const repository = object((await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, {}))['repository']);
    const open = valid.map((number) => object(repository[`pr${number}`])).filter((node) => node['state'] === 'OPEN');
    return parsePullRequestList(open.map(searchNode));
  }

  async pullRequest(number: number): Promise<ChangeRequestSummary | undefined> {
    if (!Number.isSafeInteger(number) || number <= 0) return undefined;
    const repository = object((await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pr:pullRequest(number:${number}){${searchFields}}}}`, {}))['repository']);
    return repository['pr'] === null || repository['pr'] === undefined ? undefined : parsePullRequestList([searchNode(repository['pr'])])[0];
  }

  async crossReferences(number: number): Promise<readonly unknown[]> {
    const side = '... on PullRequest{number repository{nameWithOwner}}';
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{${side}} target{${side}}}}}}}}`, { number });
    return list(object(object(object(object(data['repository'])['pullRequest'])['timelineItems']))['nodes']);
  }

  async linkedState(number: number): Promise<LinkedChangeRequestState | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      number title url state isDraft headRefName headRefOid reviewDecision viewerCanUpdate commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`, { number });
    const pr = object(object(data['repository'])['pullRequest']);
    if (typeof pr['number'] !== 'number') return undefined;
    return parseLinkedState(pr);
  }

  async pullRequestForBranch(branch: string): Promise<ChangeRequestSummary | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(first:1,states:OPEN,headRefName:$branch){nodes{${searchFields}}}}}`, { branch });
    const nodes = list(object(object(data['repository'])['pullRequests'])['nodes']);
    return nodes.length === 0 ? undefined : parsePullRequestList(nodes.map(searchNode))[0];
  }

  async createDraft(branch: string, title: string, body: string): Promise<{ readonly number: number; readonly url: string }> {
    const repository = object((await this.#graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id defaultBranchRef{name}}}', {}))['repository']);
    const created = object(object((await this.#graphql('mutation($repo:ID!,$base:String!,$head:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repo,baseRefName:$base,headRefName:$head,title:$title,body:$body,draft:true}){pullRequest{number url}}}',
      { repo: text(repository['id']), base: text(object(repository['defaultBranchRef'])['name']), head: branch, title, body }))['createPullRequest'])['pullRequest']);
    if (!Number.isSafeInteger(created['number'])) throw new Error('GitHub did not open the draft PR.');
    return { number: created['number'] as number, url: httpsUrl(created['url']) };
  }

  async conversation(number: number): Promise<ChangeRequestConversation> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){viewer{login} repository(owner:$owner,name:$name){${conversationFields}}}`,
      { number, after: null });
    const repository = object(data['repository']);
    const pullRequest = object(repository['pullRequest']);
    const nodes: unknown[] = [];
    let page = object(pullRequest['timelineItems']);
    for (let count = 0; count < 10; count++) {
      nodes.push(...list(page['nodes']));
      const info = object(page['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      const next = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${timelineField}}}}`,
        { number, after: text(info['endCursor']) });
      page = object(object(object(next['repository'])['pullRequest'])['timelineItems']);
    }
    const parsed = parseConversation(repository, object(data['viewer']), nodes);
    if (pullRequest['isCrossRepository'] !== true || !canWrite(parsed.permission)) return parsed;
    const runs = await this.#restGet(`actions/runs?status=action_required&head_sha=${encodeURIComponent(parsed.merge.headOid)}&per_page=20`).catch(() => undefined);
    const ids = typeof runs === 'object' && runs !== null && Array.isArray((runs as Record<string, unknown>)['workflow_runs'])
      ? ((runs as Record<string, unknown>)['workflow_runs'] as unknown[]).map((run) => (typeof run === 'object' && run !== null ? (run as Record<string, unknown>)['id'] : undefined))
        .filter((id): id is number => Number.isSafeInteger(id))
      : [];
    return { ...parsed, awaitingApproval: ids };
  }

  async addComment(number: number, body: string): Promise<string> {
    const data = await this.#graphql('mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{url}}}}', { id: await this.#pullRequestId(number), body });
    return httpsUrl(object(object(object(data['addComment'])['commentEdge'])['node'])['url']);
  }

  async editComment(kind: CommentKind, id: string, body: string): Promise<void> {
    const mutations: Record<CommentKind, string> = {
      issue: 'updateIssueComment(input:{id:$id,body:$body})',
      review: 'updatePullRequestReview(input:{pullRequestReviewId:$id,body:$body})',
      reviewComment: 'updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body})',
    };
    await this.#graphql(`mutation($id:ID!,$body:String!){${mutations[kind]}{clientMutationId}}`, { id, body });
  }

  async deleteIssueComment(id: string): Promise<void> {
    await this.#graphql('mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}', { id });
  }

  async hideComment(id: string, reason: string | undefined): Promise<void> {
    if (reason === undefined) await this.#graphql('mutation($id:ID!){unminimizeComment(input:{subjectId:$id}){clientMutationId}}', { id });
    else await this.#graphql('mutation($id:ID!,$reason:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$id,classifier:$reason}){clientMutationId}}', { id, reason });
  }

  async react(subjectId: string, content: ReactionContent, on: boolean): Promise<void> {
    const mutation = on ? 'addReaction' : 'removeReaction';
    await this.#graphql(`mutation($id:ID!,$content:ReactionContent!){${mutation}(input:{subjectId:$id,content:$content}){clientMutationId}}`, { id: subjectId, content });
  }

  async discardPendingReview(number: number): Promise<void> {
    const review = await this.#ownPendingReview(number);
    if (review === undefined) throw new Error('You have no pending review on this PR.');
    await this.#graphql('mutation($id:ID!){deletePullRequestReview(input:{pullRequestReviewId:$id}){clientMutationId}}', { id: review });
  }

  async dismissReview(reviewId: string, message: string): Promise<void> {
    await this.#graphql('mutation($id:ID!,$message:String!){dismissPullRequestReview(input:{pullRequestReviewId:$id,message:$message}){clientMutationId}}', { id: reviewId, message });
  }

  async updateBranch(number: number, method: 'merge' | 'rebase'): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestBranchUpdateMethod){updatePullRequestBranch(input:{pullRequestId:$id,updateMethod:$method}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: method === 'rebase' ? 'REBASE' : 'MERGE' });
  }

  async enableAutoMerge(number: number, method: MergeMethod, message: MergeMessage): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestMergeMethod!,$headline:String,$body:String){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method,commitHeadline:$headline,commitBody:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: graphqlMethods[method], headline: message.headline ?? null, body: message.body ?? null });
  }

  async disableAutoMerge(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async enqueue(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async dequeue(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async revert(number: number): Promise<{ readonly number: number; readonly url: string }> {
    const data = await this.#graphql('mutation($id:ID!){revertPullRequest(input:{pullRequestId:$id}){revertPullRequest{number url}}}', { id: await this.#pullRequestId(number) });
    const created = object(object(data['revertPullRequest'])['revertPullRequest']);
    const revertNumber = created['number'];
    if (!Number.isSafeInteger(revertNumber)) throw new Error('GitHub did not open the revert PR.');
    return { number: revertNumber as number, url: httpsUrl(created['url']) };
  }

  async restoreBranch(branch: string, oid: string): Promise<void> {
    if (!/^[a-f\d]{40,64}$/u.test(oid)) throw new Error('Unknown head commit.');
    await this.#rest('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: oid });
  }

  async rerunFailedJobs(runId: number): Promise<void> {
    await this.#rest(`actions/runs/${runId}/rerun-failed-jobs`, 'POST');
  }

  async approveWorkflowRun(runId: number): Promise<void> {
    await this.#rest(`actions/runs/${runId}/approve`, 'POST');
  }

  async changeBase(number: number, base: string): Promise<void> {
    await this.#rest(`pulls/${number}`, 'PATCH', { base });
  }

  async branches(): Promise<readonly string[]> {
    const names: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data = await this.#graphql('query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:100,after:$after){nodes{name} pageInfo{hasNextPage endCursor}}}}', { after });
      const refs = object(object(data['repository'])['refs']);
      names.push(...list(refs['nodes']).map((node) => text(object(node)['name'])));
      const info = object(refs['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    return names;
  }

  async renderMarkdown(markdown: string): Promise<string> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    const html = await githubRequest(endpoints, `${endpoints.rest}/markdown`, 'POST', { text: markdown, mode: 'gfm', context: `${owner}/${name}` });
    return typeof html === 'string' ? html : '';
  }

  async version(number: number, known?: ChangeRequestVersion): Promise<ChangeRequestVersion> {
    const polled = await this.#poll(`pulls/${number}`, known?.polled);
    if (polled === known?.polled) return known;
    const pullRequest = object(polled.data);
    return { polled, head: text(object(pullRequest['head'])['sha']), updatedAt: text(pullRequest['updated_at']) };
  }

  async listVersion(known?: ListVersion): Promise<ListVersion> {
    const polled = await this.#poll('pulls?state=all&sort=updated&direction=desc&per_page=1', known?.polled);
    if (polled === known?.polled) return known;
    const latest = object(list(polled.data)[0]);
    return { polled, latest: `${String(latest['number'] ?? '')} ${String(latest['updated_at'] ?? '')}` };
  }

  async #poll(path: string, known: Polled | undefined): Promise<Polled> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubPoll(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, known);
  }

  async #restGet(path: string): Promise<unknown> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, 'GET');
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
