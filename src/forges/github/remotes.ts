
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

/** A pull request a link names; `host` is absent for the short `owner/name#57` form. */
export interface PullRequestLink {
  readonly host?: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** Read a PR from a GitHub link such as `https://github.com/owner/name/pull/57/files#discussion_r1`, or from `owner/name#57`. */
export function parsePullRequestLink(link: string): PullRequestLink | undefined {
  const trimmed = link.trim();
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/u.exec(trimmed);
  const full = short === null ? /^(?:https?:\/\/)?([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(trimmed) : null;
  const [owner, name, digits] = short === null ? [full?.[2], full?.[3], full?.[4]] : [short[1], short[2], short[3]];
  if (owner === undefined || name === undefined || digits === undefined) return undefined;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  const host = full?.[1]?.toLowerCase();
  return host === undefined ? { owner, name, number } : { host, owner, name, number };
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
