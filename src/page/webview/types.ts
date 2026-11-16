/** Types shared between page modules. */
import type { AgentStep } from '../../core/agent.js';
import type { ChangeRequestDetails, CommentKind } from '../../core/forge.js';
import type { DiffSide, GitHubThreadView, OverviewState } from '../protocol.js';
import type { OrbMotion } from './orb.js';

/** The page's tab: the PR's record, or its code. */
export type View = 'overview' | 'code';
/** The order the Code tab shows files in: the file tree, or Claude's guide in reading order. */
export type Order = 'files' | 'guide';
export type Intent = 'ask' | 'implement';
export interface Composer { path: string; side: DiffSide; start: number; end: number; text: string; target?: 'claude' | 'github' }
/** A new comment on a whole file, written above its diff. */
export interface FileComposer { path: string; text: string; target?: 'claude' | 'github' }
export type Thread = (OverviewState['threads'][number] & { readonly source: 'local'; readonly pending?: never; readonly outdated?: never })
  | (GitHubThreadView & { readonly source: 'github' });
export type ReviewerState = ChangeRequestDetails['reviewers'][number]['state'];
export type CheckState = ChangeRequestDetails['checks'][number]['state'];
/** A question that waits for its confirm button in place of what asked it; `redraw` draws that place. */
export interface Ask { readonly key: string; readonly question: string; readonly label: string; send(): void; redraw(): void }

export type StepPick = (step: AgentStep) => readonly [OrbMotion, (number | undefined)?];

/** Where a GitHub comment sits: what kind GitHub calls it, how to redraw it, and where a quote goes. */
export interface CommentPlace { readonly kind: CommentKind; redraw(): void; quote(text: string): void }

export type ThreadKind = 'github' | 'local' | 'analysis' | 'review';

/** A thread's live log on screen before a redraw, so the orb can fly from it into Claude's new reply. */
export interface LiveLog { readonly threadId: string; readonly messages: number; readonly log: HTMLElement; readonly at: DOMRect; readonly orb: DOMRect }
