/**
 * Find in page. VS Code's own find widget breaks maximizing the panel while the page is the active editor, so the page
 * brings its own: ⌘/Ctrl+F opens it through DiffGuide's keybinding, matches show through CSS highlights, and the page's DOM stays untouched.
 */
import { $ } from './dom.js';
import { drawPendingDiffs } from './files/render.js';

const all = new Highlight();
const current = new Highlight();
CSS.highlights.set('find-match', all);
CSS.highlights.set('find-current', current);

let matches: Range[] = [];
let index = -1;
let typing: ReturnType<typeof setTimeout> | undefined;
let changed: ReturnType<typeof setTimeout> | undefined;
const watch = new MutationObserver((records) => {
  if (records.every((record) => $('find-box').contains(record.target))) return;
  clearTimeout(changed);
  changed = setTimeout(() => { search(false); }, 150);
});

/** Elements that hold one run of text, so a match never spans two lines or cells. */
const blocks = 'td,th,p,li,h1,h2,h3,h4,h5,h6,summary,pre,button,label,div';

function searchable(parent: Element, seen: Map<Element, boolean>): boolean {
  const known = seen.get(parent);
  if (known !== undefined) return known;
  // Folded lines stay findable, like the browser's find opens hidden=until-found.
  const fold = parent.closest('[hidden="until-found"]');
  const visible = !parent.closest('#find-box,script,style,template,svg')
    && (parent.checkVisibility() || (fold?.parentElement?.checkVisibility() === true && fold.parentElement.closest('[hidden="until-found"]') === null));
  seen.set(parent, visible);
  return visible;
}

/** Every case-insensitive match of `query` in the page's visible text, in page order. */
export function findRanges(query: string, root: Node = document.body): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const runs = new Map<Element, { text: string; nodes: { node: Text; start: number }[] }>();
  const seen = new Map<Element, boolean>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || !node.data.trim() || !searchable(parent, seen)) continue;
    const block = parent.closest(blocks) ?? parent;
    const run = runs.get(block) ?? { text: '', nodes: [] };
    run.nodes.push({ node, start: run.text.length });
    run.text += node.data;
    runs.set(block, run);
  }
  const found: Range[] = [];
  for (const { text, nodes } of runs.values()) {
    const lower = text.toLowerCase();
    // Lowercasing can change a string's length; offsets then only hold for the original.
    const haystack = lower.length === text.length ? lower : text;
    const at = (offset: number, end: boolean): [Text, number] => {
      const hit = nodes.findLast(({ start, node }) => (end ? start < offset : start <= offset) && offset <= start + node.data.length) ?? nodes[0]!;
      return [hit.node, offset - hit.start];
    };
    for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
      const range = document.createRange();
      range.setStart(...at(from, false));
      range.setEnd(...at(from + needle.length, true));
      found.push(range);
    }
  }
  return found.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
}

function showCount(): void {
  const query = $<HTMLInputElement>('find-input').value;
  $('find-count').textContent = !query ? '' : matches.length === 0 ? 'No results' : `${index + 1} of ${matches.length}`;
  $('find-box').classList.toggle('missing', query !== '' && matches.length === 0);
}

/** Make match `next` the current one and, with `reveal`, unfold and scroll to it. */
function select(next: number, reveal: boolean): void {
  index = matches.length === 0 ? -1 : (next + matches.length) % matches.length;
  current.clear();
  const range = matches[index];
  if (range) {
    current.add(range);
    if (reveal) {
      const element = range.startContainer.parentElement;
      const fold = element?.closest('[hidden="until-found"]');
      if (fold) { fold.dispatchEvent(new Event('beforematch')); fold.removeAttribute('hidden'); }
      const bounds = range.getBoundingClientRect();
      const top = Math.max(0, $('files-bar').getBoundingClientRect().bottom, $('code-bar').getBoundingClientRect().bottom);
      if (bounds.top < top || bounds.bottom > window.innerHeight) element?.scrollIntoView({ block: 'center' });
    }
  }
  showCount();
}

/** Search again; `reveal` jumps to the first match below the bars, otherwise the current match keeps its place. */
function search(reveal: boolean): void {
  drawPendingDiffs();
  watch.takeRecords();
  const before = matches[index];
  matches = findRanges($<HTMLInputElement>('find-input').value);
  all.clear();
  for (const range of matches) all.add(range);
  if (reveal) {
    const top = $('files-bar').getBoundingClientRect().bottom;
    const below = matches.findIndex((range) => range.getBoundingClientRect().top >= top);
    select(Math.max(below, 0), true);
  } else {
    // A redraw replaces nodes; the old match then only gives its position in the list.
    const kept = before?.startContainer.isConnected === true ? matches.findIndex((range) => range.compareBoundaryPoints(Range.START_TO_START, before) >= 0) : Math.min(index, matches.length - 1);
    select(Math.max(kept, 0), false);
  }
}

export function openFind(): void {
  const box = $('find-box');
  const input = $<HTMLInputElement>('find-input');
  const selected = window.getSelection()?.toString() ?? '';
  if (selected && !selected.includes('\n') && !box.contains(document.activeElement)) input.value = selected;
  box.hidden = false;
  input.focus({ preventScroll: true });
  input.select();
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  search(false);
}

export function closeFind(): void {
  $('find-box').hidden = true;
  watch.disconnect();
  clearTimeout(typing);
  clearTimeout(changed);
  matches = [];
  index = -1;
  all.clear();
  current.clear();
}

/** Wire the find bar and its shortcut. */
export function setupFind(): void {
  const input = $<HTMLInputElement>('find-input');
  // The page opens the bar itself, so keys typed right after the shortcut land in it; the keybinding's message comes later.
  const mac = navigator.userAgent.includes('Mac');
  window.addEventListener('keydown', (event) => {
    if ((mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
    }
  });
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { typing = undefined; search(true); }, 100);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (typing !== undefined) { clearTimeout(typing); typing = undefined; search(true); } else select(index + (event.shiftKey ? -1 : 1), true);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      closeFind();
    }
  });
  $('find-prev').addEventListener('click', () => { select(index - 1, true); });
  $('find-next').addEventListener('click', () => { select(index + 1, true); });
  $('find-close').addEventListener('click', closeFind);
}
