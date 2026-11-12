import { linkedChanges } from '../linkedController.js';
import type { LinkedChange, OverviewActions } from '../protocol.js';
import type { PullRequestPage } from './context.js';
import type { DiffView } from './diffView.js';
import type { RemoteData } from './remoteData.js';

export type LinkedActions = Pick<OverviewActions, 'openLinked' | 'pushLinked' | 'draftLinked' | 'link' | 'unlink'>;

/** The Linked changes card of a PR's page, with its rows kept between redraws. */
export class LinkedCard {
  readonly #linked: ReturnType<typeof linkedChanges>;
  /** The card's rows from the last read; reading them takes several GitHub requests, so redraws reuse them until the next reload. */
  #rows: Promise<readonly LinkedChange[]> | undefined;

  constructor(page: PullRequestPage, diff: DiffView, private readonly remote: RemoteData) {
    const { repository, pullRequest, provider, folder, opened, host } = page;
    this.#linked = linkedChanges({
      repository, pullRequest, provider, folder, base: () => diff.readBase(), dataPath: opened.dataPath, repositories: () => host.workspaceRepositories(),
      parseLink: (link) => host.parseLink(link), openPage: (name, number) => host.openLinkedPage(name, number),
    });
  }

  read(): Promise<readonly LinkedChange[]> {
    this.#rows ??= this.#linked.read().catch(() => []);
    return this.#rows;
  }

  /** Read the rows again on the next redraw. */
  forget(): void {
    this.#rows = undefined;
  }

  /** Read the rows again behind the last ones, so the card keeps showing them until GitHub answers. */
  reloadBehind(): void {
    const next = this.#linked.read().catch(() => []);
    void next.then(() => { this.#rows = next; this.remote.changed(); });
  }

  actions(): LinkedActions {
    const linked = this.#linked;
    const changed = (): void => { this.forget(); this.remote.changed(); };
    return {
      openLinked: (key) => linked.open(key),
      pushLinked: async (key) => { await linked.push(key); changed(); },
      draftLinked: async (key) => { const url = await linked.draft(key); changed(); return url; },
      link: async (link) => { await linked.link(link); changed(); },
      unlink: async (key) => { await linked.unlink(key); changed(); },
    };
  }
}
