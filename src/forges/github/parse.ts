import { record } from '../../core/connection.js';
import { type Annotation, type ChangeRequestConversation, type ChangeRequestDetails, type ChangeRequestFile, type ChangeRequestSummary, type CheckExtras, type ConversationComment, type Label, type LinkedChangeRequestState, type MergeMethod, type MergeState, type Milestone, type PickerOptions, type ReactionContent, reactionContents, type ReactionCount, type RemoteThread, type RepositoryPermission, type RequestedReviewer, strongestVerdict, type TimelineItem } from '../../core/forge.js';

/** A search or repository PR node in the shape `parsePullRequestList` reads. */
export function searchNode(node: unknown): Record<string, unknown> {
  const record = object(node);
  return { ...record, author: record['author'] ?? { login: 'ghost' }, latestReviews: list(object(record['latestReviews'] ?? { nodes: [] })['nodes']) };
}

/** Validate a PR list from a GitHub search, rejecting the whole response on any malformed entry. */
export function parsePullRequestList(value: unknown): readonly ChangeRequestSummary[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid PR list.');
  return (value as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const number = record['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub returned an invalid PR number.');
    }
    const reviews = Array.isArray(record['latestReviews']) ? record['latestReviews'] as readonly unknown[] : [];
    const review = strongestVerdict(reviews.map((entry) => String(typeof entry === 'object' && entry !== null ? (entry as { state?: unknown }).state : '')));
    const createdAt = isoTime(record['createdAt']);
    const updatedAt = isoTime(record['updatedAt']);
    const [additions, deletions, files] = [record['additions'], record['deletions'], record['changedFiles']].map(count);
    const requestedReviewers = requestedReviewersOf(record['reviewRequests']);
    return {
      number,
      title: text(record['title']),
      url: httpsUrl(record['url']),
      author: text(object(record['author'])['login']),
      draft: record['isDraft'] === true,
      headBranch: text(record['headRefName']),
      baseBranch: text(record['baseRefName']),
      ...(typeof record['headRefOid'] === 'string' && /^[a-f\d]{40,64}$/u.test(record['headRefOid']) ? { headOid: record['headRefOid'] } : {}),
      ...(review === undefined ? {} : { review }),
      ...createdAt === undefined ? {} : { createdAt },
      ...updatedAt === undefined ? {} : { updatedAt },
      ...additions === undefined || deletions === undefined || files === undefined ? {} : { changes: { additions, deletions, files } },
      ...requestedReviewers.length === 0 ? {} : { requestedReviewers },
    };
  });
}

/** Pending reviewers from a `reviewRequests` connection, skipping entries GitHub left incomplete. */
function requestedReviewersOf(value: unknown): readonly RequestedReviewer[] {
  const nodes = record(value)?.['nodes'];
  if (!Array.isArray(nodes)) return [];
  return (nodes as readonly unknown[]).flatMap((node): RequestedReviewer[] => {
    const reviewer = typeof node === 'object' && node !== null ? (node as { requestedReviewer?: unknown }).requestedReviewer : undefined;
    if (typeof reviewer !== 'object' || reviewer === null) return [];
    const { __typename: type, login, name } = reviewer as { __typename?: unknown; login?: unknown; name?: unknown };
    const team = type === 'Team';
    const label = team ? name : login;
    return typeof label === 'string' && label ? [{ name: label, team }] : [];
  });
}

const changeTypes: Record<string, ChangeRequestFile['change']> = {
  ADDED: 'added', MODIFIED: 'modified', DELETED: 'deleted', RENAMED: 'renamed', CHANGED: 'modified', COPIED: 'added',
};

/** Validate a PR's changed files, rejecting paths that leave the repository. */
export function parsePullRequestFiles(value: unknown): readonly ChangeRequestFile[] {
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

const reviewStates: Record<string, ChangeRequestDetails['reviewers'][number]['state']> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed',
};

/** Map a check run conclusion or commit status to one of four states. */
function checkState(raw: unknown): ChangeRequestDetails['checks'][number]['state'] {
  const value = String(raw);
  if (value === 'SUCCESS') return 'success';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) return 'failure';
  if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(value)) return 'neutral';
  return 'pending';
}

/** Validate PR details from GraphQL; reviewers without an account and malformed checks are left out. */
export function parseDetails(repository: Record<string, unknown>, viewer: Record<string, unknown> = {}): ChangeRequestDetails {
  const pullRequest = object(repository['pullRequest']);
  const methods: readonly [string, MergeMethod][] = [['squashMergeAllowed', 'squash'], ['mergeCommitAllowed', 'merge'], ['rebaseMergeAllowed', 'rebase']];
  const reviewers: ChangeRequestDetails['reviewers'][number][] = [];
  const author = object(pullRequest['author'] ?? {})['login'];
  // Opinionated reviews leave out comment-only ones, so commenters come from latestReviews; the author's replies in review threads count as reviews there.
  const reviews = [...list(object(pullRequest['latestOpinionatedReviews'])['nodes']), ...list(object(pullRequest['latestReviews'] ?? { nodes: [] })['nodes'])];
  for (const node of reviews) {
    const review = object(node);
    const login = typeof review['author'] === 'object' && review['author'] !== null ? (review['author'] as { login?: unknown }).login : undefined;
    const state = reviewStates[String(review['state'])];
    if (typeof login === 'string' && state !== undefined && login !== author && !reviewers.some((entry) => entry.name === login)) reviewers.push({ name: login, state });
  }
  for (const node of list(object(pullRequest['reviewRequests'])['nodes'])) {
    const reviewer = object(node)['requestedReviewer'];
    const record = typeof reviewer === 'object' && reviewer !== null ? reviewer as { login?: unknown; name?: unknown; slug?: unknown } : {};
    const name = record.login ?? record.name;
    if (typeof name !== 'string') continue;
    const reviewed = reviewers.findIndex((entry) => entry.name === name);
    const entry = reviewers[reviewed];
    if (entry !== undefined && typeof record.login === 'string' && entry.state !== 'requested') reviewers[reviewed] = { ...entry, rerequested: true };
    if (entry !== undefined) continue;
    reviewers.push({ name, state: 'requested', ...(typeof record.slug === 'string' ? { team: record.slug } : {}) });
  }
  const commit = list(object(pullRequest['commits'])['nodes'])[0];
  const rollup = commit === undefined ? null : object(object(commit)['commit'])['statusCheckRollup'];
  const checks: ChangeRequestDetails['checks'][number][] = [];
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
  const fork = object(pullRequest['headRepository'] ?? {})['nameWithOwner'];
  return {
    ...(pullRequest['isCrossRepository'] === true && typeof fork === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(fork) ? { headRepository: fork } : {}),
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
    viewerAvatarUrl: optionalHttpsUrl(viewer['avatarUrl']),
    ...displayName(viewer) === undefined ? {} : { viewerName: displayName(viewer) as string },
    mergeMethods: methods.filter(([key]) => repository[key] === true).map(([, method]) => method),
    reviewers,
    checks,
    ...parseMilestone(pullRequest['milestone']),
  };
}

function parseMilestone(value: unknown): { milestone?: Milestone } {
  if (typeof value !== 'object' || value === null) return {};
  const { number, title } = value as Record<string, unknown>;
  return Number.isSafeInteger(number) && typeof title === 'string' ? { milestone: { number: number as number, title } } : {};
}

const reactionSet: ReadonlySet<string> = new Set(reactionContents);

/** Reactions anyone left, in GitHub's order, without empty ones. */
function parseReactions(groups: unknown): readonly ReactionCount[] {
  if (!Array.isArray(groups)) return [];
  return groups.map(object).flatMap((group) => {
    const content = group['content'];
    const total = count(object(group['reactors'] ?? {})['totalCount']);
    return typeof content === 'string' && reactionSet.has(content) && total !== undefined && total > 0
      ? [{ content: content as ReactionContent, count: total, viewerReacted: group['viewerHasReacted'] === true }] : [];
  });
}

/** A comment, review or review comment as GitHub sent it; a deleted user shows as ghost. */
function parseComment(comment: Record<string, unknown>): ConversationComment {
  const author = comment['author'] === null || comment['author'] === undefined ? {} : object(comment['author']);
  const url = typeof comment['url'] === 'string' ? optionalHttpsUrl(comment['url']) : '';
  const reason = comment['minimizedReason'];
  return {
    id: text(comment['id']),
    author: typeof author['login'] === 'string' ? author['login'] : 'ghost',
    ...typeof author['name'] === 'string' && author['name'].trim() ? { authorName: author['name'].trim() } : {},
    avatarUrl: optionalHttpsUrl(author['avatarUrl']),
    createdAt: typeof comment['createdAt'] === 'string' ? comment['createdAt'] : '',
    bodyHtml: typeof comment['bodyHTML'] === 'string' ? comment['bodyHTML'] : '',
    body: typeof comment['body'] === 'string' ? comment['body'] : '',
    ...url ? { url } : {},
    canEdit: comment['viewerCanUpdate'] === true,
    canDelete: comment['viewerCanDelete'] === true,
    canHide: comment['viewerCanMinimize'] === true,
    canReact: comment['viewerCanReact'] === true,
    ...comment['isMinimized'] === true ? { hidden: typeof reason === 'string' && reason ? reason.toLowerCase().replaceAll('_', ' ') : 'hidden' } : {},
    edited: typeof comment['lastEditedAt'] === 'string',
    reactions: parseReactions(comment['reactionGroups']),
  };
}

const reviewTimelineStates: Record<string, Extract<TimelineItem, { kind: 'review' }>['state']> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending',
};

function login(value: unknown): string {
  const name = record(value)?.['login'];
  return typeof name === 'string' ? name : 'ghost';
}

/** What a timeline event says, in GitHub's words without the actor; undefined for events the page leaves out. */
function eventText(node: Record<string, unknown>): string | undefined {
  const name = (value: unknown): string => {
    const actor = record(value) ?? {};
    return typeof actor['login'] === 'string' ? actor['login'] : typeof actor['name'] === 'string' ? actor['name'] : 'someone';
  };
  const field = (key: string): string => typeof node[key] === 'string' ? node[key] : '';
  const label = (): string => typeof node['label'] === 'object' && node['label'] !== null ? String((node['label'] as { name?: unknown }).name ?? '') : '';
  const short = (key: string): string => typeof node[key] === 'object' && node[key] !== null ? String((node[key] as { abbreviatedOid?: unknown }).abbreviatedOid ?? '') : '';
  switch (node['__typename']) {
    case 'HeadRefForcePushedEvent': return `force-pushed the branch from ${short('beforeCommit') || 'an earlier commit'} to ${short('afterCommit') || 'a new commit'}`;
    case 'LabeledEvent': return `added the ${label()} label`;
    case 'UnlabeledEvent': return `removed the ${label()} label`;
    case 'ReviewRequestedEvent': return `requested a review from ${name(node['requestedReviewer'])}`;
    case 'ReviewRequestRemovedEvent': return `removed the review request for ${name(node['requestedReviewer'])}`;
    case 'ReviewDismissedEvent': return `dismissed ${login(object(node['review'] ?? {})['author'])}'s review`;
    case 'MergedEvent': return `merged commit ${short('commit')} into ${field('mergeRefName')}`;
    case 'ClosedEvent': return 'closed this';
    case 'ReopenedEvent': return 'reopened this';
    case 'ReadyForReviewEvent': return 'marked this ready for review';
    case 'ConvertToDraftEvent': return 'converted this to a draft';
    case 'AssignedEvent': return `assigned ${name(node['assignee'])}`;
    case 'UnassignedEvent': return `unassigned ${name(node['assignee'])}`;
    case 'RenamedTitleEvent': return `changed the title from "${field('previousTitle')}" to "${field('currentTitle')}"`;
    case 'BaseRefChangedEvent': return `changed the base branch from ${field('previousRefName')} to ${field('currentRefName')}`;
    case 'HeadRefDeletedEvent': return `deleted the ${field('headRefName')} branch`;
    case 'HeadRefRestoredEvent': return 'restored the head branch';
    case 'CrossReferencedEvent': {
      const source = typeof node['source'] === 'object' && node['source'] !== null ? node['source'] as Record<string, unknown> : {};
      if (!Number.isSafeInteger(source['number'])) return undefined;
      const where = String((source['repository'] as { nameWithOwner?: unknown } | undefined)?.nameWithOwner ?? '');
      return `${node['willCloseTarget'] === true ? 'linked' : 'mentioned this in'} ${where}#${String(source['number'])} ${String(source['title'] ?? '')}`.trim();
    }
    case 'AutoMergeEnabledEvent': return 'enabled auto-merge';
    case 'AutoMergeDisabledEvent': return 'disabled auto-merge';
    case 'MilestonedEvent': return `added this to the ${field('milestoneTitle')} milestone`;
    case 'DemilestonedEvent': return `removed this from the ${field('milestoneTitle')} milestone`;
    default: return undefined;
  }
}

/** Timeline entries the page shows, skipping kinds it does not know and entries GitHub sent incomplete. */
function parseTimeline(nodes: readonly unknown[]): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of nodes) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') continue;
    const node = entry as Record<string, unknown>;
    const kind = node['__typename'];
    if (kind === 'IssueComment') items.push({ kind: 'comment', ...parseComment(node) });
    else if (kind === 'PullRequestReview') {
      const state = reviewTimelineStates[String(node['state'])];
      if (state === undefined) continue;
      const commit = typeof node['commit'] === 'object' && node['commit'] !== null ? (node['commit'] as { oid?: unknown }).oid : undefined;
      const comment = parseComment(node);
      const submitted = typeof node['submittedAt'] === 'string' ? node['submittedAt'] : comment.createdAt;
      const nodes = typeof node['comments'] === 'object' && node['comments'] !== null ? (node['comments'] as { nodes?: unknown }).nodes : undefined;
      const comments = (Array.isArray(nodes) ? nodes : []).map((entry: unknown) => typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined).filter((id): id is string => typeof id === 'string');
      items.push({ kind: 'review', ...comment, createdAt: submitted, state, comments, ...typeof commit === 'string' ? { commit } : {} });
    } else if (kind === 'PullRequestCommit') {
      const commit = object(node['pushed']);
      const oid = commit['oid'];
      if (typeof oid !== 'string' || !/^[a-f\d]{40,64}$/u.test(oid)) continue;
      const author = object(commit['author'] ?? {});
      const user = typeof author['user'] === 'object' && author['user'] !== null ? author['user'] as Record<string, unknown> : undefined;
      const rollup = typeof commit['statusCheckRollup'] === 'object' && commit['statusCheckRollup'] !== null ? String((commit['statusCheckRollup'] as { state?: unknown }).state) : undefined;
      const checks = rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : undefined;
      items.push({
        kind: 'commit', id: node['id'] as string, oid,
        headline: typeof commit['messageHeadline'] === 'string' ? commit['messageHeadline'] : '',
        message: typeof commit['messageBody'] === 'string' ? commit['messageBody'] : '',
        author: typeof user?.['login'] === 'string' ? user['login'] : typeof author['name'] === 'string' ? author['name'] : 'unknown',
        avatarUrl: optionalHttpsUrl(author['avatarUrl']),
        createdAt: typeof commit['committedDate'] === 'string' ? commit['committedDate'] : '',
        ...checks === undefined ? {} : { checks },
        ...typeof commit['additions'] === 'number' && typeof commit['deletions'] === 'number' ? { additions: commit['additions'], deletions: commit['deletions'] } : {},
        ...typeof commit['changedFilesIfAvailable'] === 'number' ? { files: commit['changedFilesIfAvailable'] } : {},
      });
    } else {
      const said = eventText(node);
      if (said === undefined) continue;
      const actor = typeof node['actor'] === 'object' && node['actor'] !== null ? node['actor'] as Record<string, unknown> : {};
      items.push({
        kind: 'event', id: node['id'] as string, actor: typeof actor['login'] === 'string' ? actor['login'] : 'ghost',
        avatarUrl: optionalHttpsUrl(actor['avatarUrl']), createdAt: typeof node['createdAt'] === 'string' ? node['createdAt'] : '', text: said,
      });
    }
  }
  return items;
}

const mergeStates: Record<string, MergeState> = {
  BEHIND: 'behind', BLOCKED: 'blocked', CLEAN: 'clean', DIRTY: 'dirty', HAS_HOOKS: 'hasHooks', UNKNOWN: 'unknown', UNSTABLE: 'unstable',
};
const permissions: Record<string, RepositoryPermission> = { ADMIN: 'admin', MAINTAIN: 'maintain', WRITE: 'write', TRIAGE: 'triage', TRIAGE_PLUS: 'triage', READ: 'read' };
const mergeMethodNames: Record<string, MergeMethod> = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };
const annotationLevels: Record<string, Annotation['level']> = { FAILURE: 'failure', WARNING: 'warning', NOTICE: 'notice' };

/** Whether a repository role may push, dismiss reviews and re-run workflows. */
export function canWrite(permission: RepositoryPermission): boolean {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

/** Validate the Conversation query: `repository` holds the PR's extras, `timeline` every page of timeline nodes. */
export function parseConversation(repository: Record<string, unknown>, viewer: Record<string, unknown>, timeline: readonly unknown[]): ChangeRequestConversation {
  const pullRequest = object(repository['pullRequest']);
  const viewerLogin = typeof viewer['login'] === 'string' ? viewer['login'] : '';
  const items = parseTimeline(timeline);
  const auto = typeof pullRequest['autoMergeRequest'] === 'object' && pullRequest['autoMergeRequest'] !== null ? pullRequest['autoMergeRequest'] as Record<string, unknown> : undefined;
  const autoMethod = auto === undefined ? undefined : mergeMethodNames[String(auto['mergeMethod'])];
  const queue = typeof pullRequest['mergeQueueEntry'] === 'object' && pullRequest['mergeQueueEntry'] !== null ? (pullRequest['mergeQueueEntry'] as { position?: unknown }).position : undefined;
  const decision = pullRequest['reviewDecision'];
  const headOid = typeof pullRequest['headRefOid'] === 'string' ? pullRequest['headRefOid'] : '';
  const commit = list(object(pullRequest['commits'] ?? { nodes: [] })['nodes'])[0];
  const rollup = commit === undefined ? null : object(object(commit)['commit'])['statusCheckRollup'];
  const checks: CheckExtras[] = [];
  if (typeof rollup === 'object' && rollup !== null) {
    for (const node of list(object((rollup as Record<string, unknown>)['contexts'])['nodes'])) {
      const check = object(node);
      const run = check['__typename'] === 'CheckRun';
      const name = run ? check['name'] : check['context'];
      if (typeof name !== 'string') continue;
      const workflow = run && typeof check['checkSuite'] === 'object' && check['checkSuite'] !== null ? (check['checkSuite'] as { workflowRun?: unknown }).workflowRun : undefined;
      const runId = typeof workflow === 'object' && workflow !== null ? (workflow as { databaseId?: unknown }).databaseId : undefined;
      const annotations = run ? list(object(check['annotations'] ?? { nodes: [] })['nodes']).map(object).flatMap((note): Annotation[] => {
        const location = object(note['location'] ?? {});
        const start = object(location['start'] ?? {})['line'];
        const end = object(location['end'] ?? {})['line'];
        const path = note['path'];
        const level = annotationLevels[String(note['annotationLevel'])];
        if (typeof path !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || level === undefined || (start as number) < 1) return [];
        return [{ path, startLine: start as number, endLine: Math.max(start as number, end as number), level,
          title: typeof note['title'] === 'string' ? note['title'] : '', message: typeof note['message'] === 'string' ? note['message'] : '' }];
      }) : [];
      checks.push({ name, required: check['isRequired'] === true, ...Number.isSafeInteger(runId) ? { runId: runId as number } : {}, annotations });
    }
  }
  const reviewIds: Record<string, string> = {};
  for (const node of list(object(pullRequest['latestOpinionatedReviews'] ?? { nodes: [] })['nodes']).map(object)) {
    const author = login(node['author']);
    if (typeof node['id'] === 'string' && author !== 'ghost') reviewIds[author] = node['id'];
  }
  const lastReviewedCommit = items.filter((item): item is Extract<TimelineItem, { kind: 'review' }> => item.kind === 'review' && item.author === viewerLogin && item.state !== 'pending' && item.commit !== undefined).at(-1)?.commit;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
  return {
    timeline: items,
    description: { id: text(pullRequest['id']), reactions: parseReactions(pullRequest['reactionGroups']), canReact: pullRequest['viewerCanReact'] === true },
    viewerLogin,
    permission: permissions[String(repository['viewerPermission'])] ?? 'none',
    merge: {
      state: mergeStates[String(pullRequest['mergeStateStatus'])] ?? 'unknown',
      ...decision === 'APPROVED' ? { reviewDecision: 'approved' } : decision === 'CHANGES_REQUESTED' ? { reviewDecision: 'changes' } : decision === 'REVIEW_REQUIRED' ? { reviewDecision: 'required' } : {},
      canUpdateBranch: pullRequest['viewerCanUpdateBranch'] === true,
      canBypass: pullRequest['viewerCanMergeAsAdmin'] === true,
      ...autoMethod === undefined ? {} : { autoMerge: { method: autoMethod, enabledBy: login(auto?.['enabledBy']) } },
      canEnableAutoMerge: pullRequest['viewerCanEnableAutoMerge'] === true,
      canDisableAutoMerge: pullRequest['viewerCanDisableAutoMerge'] === true,
      autoMergeAllowed: repository['autoMergeAllowed'] === true,
      mergeQueue: pullRequest['isMergeQueueEnabled'] === true,
      ...Number.isSafeInteger(queue) ? { queuePosition: (queue as number) + 1 } : {},
      headOid,
      headDeleted: pullRequest['headRef'] === null && pullRequest['isCrossRepository'] !== true,
    },
    checks,
    linkedIssues: list(object(pullRequest['closingIssuesReferences'] ?? { nodes: [] })['nodes']).map(object).flatMap((issue) => {
      const url = optionalHttpsUrl(issue['url']);
      return Number.isSafeInteger(issue['number']) && typeof issue['title'] === 'string' && url
        ? [{ number: issue['number'] as number, title: issue['title'], url, open: issue['state'] === 'OPEN' }] : [];
    }),
    reviewIds,
    commitDefaults: {
      squashTitle: pick(repository['squashMergeCommitTitle'], ['PR_TITLE', 'COMMIT_OR_PR_TITLE'], 'COMMIT_OR_PR_TITLE'),
      squashBody: pick(repository['squashMergeCommitMessage'], ['PR_BODY', 'COMMIT_MESSAGES', 'BLANK'], 'COMMIT_MESSAGES'),
      mergeTitle: pick(repository['mergeCommitTitle'], ['PR_TITLE', 'MERGE_MESSAGE'], 'MERGE_MESSAGE'),
      mergeBody: pick(repository['mergeCommitMessage'], ['PR_TITLE', 'PR_BODY', 'BLANK'], 'PR_TITLE'),
    },
    ...lastReviewedCommit === undefined ? {} : { lastReviewedCommit },
    awaitingApproval: [],
  };
}

function logins(connection: unknown): readonly string[] {
  return list(object(connection)['nodes']).map((node) => object(node)['login']).filter((login): login is string => typeof login === 'string');
}

/** Labels with a six-digit hex color; others are left out. */
function parseLabels(connection: unknown): readonly Label[] {
  return list(object(connection)['nodes']).map(object).flatMap((label) => {
    const { name, color, description } = label;
    if (typeof name !== 'string' || typeof color !== 'string' || !/^[0-9a-f]{6}$/iu.test(color)) return [];
    return [typeof description === 'string' && description.trim() ? { name, color, description: description.trim() } : { name, color }];
  });
}

/** A linked PR's state from a `pullRequest` node. */
export function parseLinkedState(pr: Record<string, unknown>): LinkedChangeRequestState {
  const rollup = object(object(object(list(object(pr['commits'])['nodes'])[0])['commit'])['statusCheckRollup'])['state'];
  const checks = rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : undefined;
  const decision = pr['reviewDecision'];
  const review = decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : undefined;
  return {
    number: pr['number'] as number, title: text(pr['title']), url: httpsUrl(pr['url']),
    state: pr['state'] === 'MERGED' ? 'merged' : pr['state'] === 'CLOSED' ? 'closed' : 'open', draft: pr['isDraft'] === true,
    headBranch: text(pr['headRefName']), headOid: text(pr['headRefOid']), canPush: pr['viewerCanUpdate'] === true,
    ...(checks === undefined ? {} : { checks }), ...(review === undefined ? {} : { review }),
  };
}

/** Users, teams and labels for the reviewer, assignee and label pickers; a repository owned by a user has no teams. */
export function parsePickerOptions(repository: Record<string, unknown>): PickerOptions {
  const owner = repository['owner'];
  const teams = typeof owner === 'object' && owner !== null && 'teams' in owner ? list(object((owner as Record<string, unknown>)['teams'])['nodes']).map(object) : [];
  return {
    users: logins(repository['assignableUsers']),
    teams: teams.flatMap(({ name, slug }) => typeof name === 'string' && typeof slug === 'string' ? [{ name, slug }] : []),
    labels: parseLabels(repository['labels']),
    milestones: list(object(repository['milestones'] ?? { nodes: [] })['nodes']).map(parseMilestone).flatMap((entry) => entry.milestone === undefined ? [] : [entry.milestone]),
  };
}

/** Read review threads, file-level ones at placeholder line 1, skipping threads whose comments are all gone. */
export function parseReviewThreads(nodes: unknown): readonly RemoteThread[] {
  const threads: RemoteThread[] = [];
  for (const node of list(nodes)) {
    const thread = object(node);
    const outdated = thread['isOutdated'] === true;
    const endLine = outdated ? thread['originalLine'] : thread['line'];
    const startLine = (outdated ? thread['originalStartLine'] : thread['startLine']) ?? endLine;
    const comments = list(object(thread['comments'])['nodes']).map(object);
    const file = thread['subjectType'] === 'FILE';
    if ((!file && (!Number.isSafeInteger(endLine) || !Number.isSafeInteger(startLine))) || comments.length === 0) continue;
    threads.push({
      id: text(thread['id']),
      path: text(thread['path']),
      side: thread['diffSide'] === 'LEFT' ? 'LEFT' : 'RIGHT',
      startLine: file ? 1 : startLine as number,
      endLine: file ? 1 : endLine as number,
      outdated,
      resolved: thread['isResolved'] === true,
      pending: comments[0]?.['state'] === 'PENDING',
      url: httpsUrl(comments[0]?.['url']),
      comments: comments.map((comment) => ({ ...parseComment(comment), pending: comment['state'] === 'PENDING' })),
      ...(file ? { scope: 'file' as const } : {}),
      ...(typeof comments[0]?.['diffHunk'] === 'string' && comments[0]['diffHunk'] !== '' ? { diffHunk: comments[0]['diffHunk'] } : {}),
    });
  }
  return threads;
}

/** Narrow an untrusted CLI value to a plain object. */
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as Record<string, unknown>;
}

/** Narrow an untrusted CLI value to an array. */
export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as readonly unknown[];
}

/** Require a non-empty string without coercion. */
/** A non-negative count from GitHub, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** An ISO time from GitHub, or undefined when it does not parse. */
function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GitHub returned incomplete data.');
  return value;
}

/** Accept only credential-free HTTPS links for browser navigation. */
/** A user's profile name, else their login; undefined when GitHub sent neither. */
function displayName(user: Record<string, unknown>): string | undefined {
  const name = user['name'];
  if (typeof name === 'string' && name.trim()) return name.trim();
  return typeof user['login'] === 'string' && user['login'] ? user['login'] : undefined;
}

/** A link GitHub may leave out, such as a deleted user's avatar; empty when missing or not https. */
function optionalHttpsUrl(value: unknown): string {
  try {
    return httpsUrl(value);
  } catch {
    return '';
  }
}

export function httpsUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('GitHub returned an invalid link.');
  return url.toString();
}
