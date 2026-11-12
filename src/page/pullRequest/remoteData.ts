import { Emitter } from '../../core/events.js';
import type { ChangeRequestConversation, ChangeRequestDetails, Forge, RemoteThread } from '../../core/forge.js';
import { PendingWrites, sharedPerTurn } from './githubReads.js';

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** A PR's details, review threads and conversation from GitHub, each read once and kept until the next reload. */
export class RemoteData {
  readonly #changed = new Emitter<void>();
  /** Fires when a read finishes, or the page must redraw for another reason. */
  readonly onDidChange = this.#changed.event;
  /** The user's own changes on GitHub, kept on the page until GitHub's reads catch up with them. */
  readonly written = new PendingWrites();
  #details: Promise<ChangeRequestDetails | Error> | undefined;
  #threads: Promise<readonly RemoteThread[] | Error> | undefined;
  #conversation: Promise<ChangeRequestConversation | Error> | undefined;

  constructor(private readonly provider: Forge, private readonly number: number, private readonly refreshSidebar: () => void) {}

  readonly loadDetails = sharedPerTurn((): Promise<ChangeRequestDetails | Error> => {
    this.#details = this.provider.details(this.number).catch(asError);
    void this.#details.then(() => { this.changed(); });
    return this.#details;
  });

  readonly loadConversation = sharedPerTurn((): Promise<ChangeRequestConversation | Error> => {
    this.#conversation = this.provider.conversation(this.number).catch(asError);
    void this.#conversation.then(() => { this.changed(); });
    return this.#conversation;
  });

  readonly loadThreads = sharedPerTurn((): Promise<readonly RemoteThread[] | Error> => {
    this.#threads = this.provider.threads(this.number).catch(asError);
    void this.#threads.then(() => { this.changed(); });
    return this.#threads;
  });

  changed(): void {
    this.#changed.fire();
  }

  details(): Promise<ChangeRequestDetails | Error> {
    return this.#details ?? this.loadDetails();
  }

  threads(): Promise<readonly RemoteThread[] | Error> {
    return this.#threads ?? this.loadThreads();
  }

  conversation(): Promise<ChangeRequestConversation | Error> {
    return this.#conversation ?? this.loadConversation();
  }

  async currentDetails(): Promise<ChangeRequestDetails> {
    const loaded = await this.details();
    if (loaded instanceof Error) throw loaded;
    return loaded;
  }

  async currentConversation(): Promise<ChangeRequestConversation> {
    const loaded = await this.conversation();
    if (loaded instanceof Error) throw loaded;
    return loaded;
  }

  /** Details and threads in one request on first load; a failed combined request falls back to separate ones. */
  loadFirst(): void {
    if (this.#details !== undefined || this.#threads !== undefined) return;
    const both = this.provider.overview(this.number);
    this.#details = both.then(({ details: loaded }) => loaded, () => this.provider.details(this.number)).catch(asError);
    this.#threads = both.then(({ threads }) => threads, () => this.provider.threads(this.number)).catch(asError);
    void this.#details.then(() => { this.changed(); });
    void this.#threads.then(() => { this.changed(); });
  }

  /** Reload the page's details and the sidebar after a change it lists, such as title, draft or open state. */
  changedOnGitHub(): void {
    void this.loadDetails();
    void this.loadConversation();
    this.refreshSidebar();
  }

  /** Reload details and conversation behind the last values, so the page keeps showing them until GitHub answers. */
  reloadBehind(): void {
    const nextDetails = this.provider.details(this.number).catch(asError);
    const nextConversation = this.provider.conversation(this.number).catch(asError);
    void nextDetails.then(() => { this.#details = nextDetails; this.changed(); });
    void nextConversation.then(() => { this.#conversation = nextConversation; this.changed(); });
  }
}
