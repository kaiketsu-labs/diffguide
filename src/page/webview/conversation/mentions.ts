/** Text fields that post to GitHub, with @mention completion. */
import { button, el } from '../dom.js';
import { previewTabs } from '../messages.js';
import { received, ui } from '../state.js';
import { textarea } from '../threads/composer.js';
import { post } from '../transport.js';

export const renderedPreviews = new Map<string, { readonly text: string; readonly html?: string }>();
let mentionsAsked = false;

/** A text box for GitHub with Write and Preview tabs, and @mention completion. */
export function githubField(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLElement {
  let text = value;
  const wrap = el('div', 'field');
  const draw = (): void => {
    const showing = previewTabs.has(key);
    const tabs = el('div', 'seg field-tabs');
    for (const [label, on] of [['Write', false], ['Preview', true]] as const) {
      const tab = button(label, () => {
        if (on) previewTabs.add(key);
        else previewTabs.delete(key);
        if (on && text.trim() && renderedPreviews.get(key)?.text !== text) {
          renderedPreviews.set(key, { text });
          post({ action: 'markdown', form: key, text });
        }
        draw();
        if (!on) wrap.querySelector('textarea')?.focus();
      });
      tab.setAttribute('aria-pressed', String(showing === on));
      tabs.append(tab);
    }
    if (showing) {
      const box = el('div', 'md-preview msg-text');
      box.dataset.preview = key;
      const shown = renderedPreviews.get(key);
      if (!text.trim()) box.append(el('span', 'muted', 'Nothing to preview.'));
      else if (shown?.html === undefined) box.append(el('span', 'muted', 'Loading preview…'));
      else box.innerHTML = shown.html;
      wrap.replaceChildren(tabs, box);
    } else {
      const area = textarea(key, text, placeholder, (next) => { text = next; onInput(next); }, onSubmit, onCancel);
      attachMentions(area, wrap);
      wrap.replaceChildren(tabs, area);
    }
  };
  draw();
  return wrap;
}

/** People to @mention: who can be assigned, plus everyone on this PR. */
function mentionCandidates(): string[] {
  const names = new Set(ui.pickerOptions?.users ?? []);
  const state = received.current;
  for (const item of state?.conversation?.timeline ?? []) if (item.kind !== 'event') names.add(item.author);
  for (const thread of state?.github ?? []) for (const entry of thread.messages) names.add(entry.author);
  for (const reviewer of state?.details?.reviewers ?? []) if (reviewer.team === undefined) names.add(reviewer.name);
  if (state) names.add(state.author);
  names.delete('ghost');
  names.delete(state?.conversation?.viewerLogin ?? '');
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Complete `@name` from `mentionCandidates` while typing; arrows pick, Enter or Tab inserts, Escape closes. */
export function attachMentions(area: HTMLTextAreaElement, wrap: HTMLElement): void {
  let list: HTMLElement | undefined;
  let matches: string[] = [];
  let at = 0;
  const close = (): void => { list?.remove(); list = undefined; };
  const query = (): { start: number; text: string } | undefined => {
    const match = /(?:^|[\s(])@([\w-]*)$/u.exec(area.value.slice(0, area.selectionStart));
    const typed = match?.[1];
    return typed === undefined ? undefined : { start: area.selectionStart - typed.length, text: typed.toLowerCase() };
  };
  const choose = (login: string): void => {
    const typed = query();
    if (!typed) return;
    area.setRangeText(login + ' ', typed.start, area.selectionStart, 'end');
    area.dispatchEvent(new Event('input'));
    close();
    area.focus();
  };
  const show = (): void => {
    const typed = query();
    if (!ui.pickerOptions && !mentionsAsked) { mentionsAsked = true; post({ action: 'picker-options' }); }
    matches = typed === undefined ? [] : mentionCandidates().filter((login) => login.toLowerCase().startsWith(typed.text)).slice(0, 8);
    if (!matches.length) { close(); return; }
    at = Math.min(at, matches.length - 1);
    list ??= el('div', 'mentions');
    list.style.top = area.offsetTop + area.offsetHeight + 2 + 'px';
    list.replaceChildren(...matches.map((login, index) => {
      const option = button('@' + login, () => choose(login));
      option.setAttribute('aria-selected', String(index === at));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      return option;
    }));
    wrap.append(list);
  };
  area.addEventListener('input', (event) => { if (event.isTrusted) { at = 0; show(); } });
  area.addEventListener('keydown', (event) => {
    if (!list) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      at = (at + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      show();
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
      const login = matches[at];
      if (login === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(login);
    } else if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  }, { capture: true });
  area.addEventListener('blur', () => { setTimeout(close, 150); });
}
