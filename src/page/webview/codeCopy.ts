/** One Copy button that shows on whichever rendered code block the pointer is over. */
import { icons } from '../icons.js';
import { $, el, icon, setTip } from './dom.js';

let shownOn: HTMLElement | undefined;

/** Code blocks in rendered Markdown and GitHub bodies; diff lines are table cells, not `pre`. */
function codeBlockAt(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element ? target.closest<HTMLElement>('pre') ?? undefined : undefined;
}

export function setupCodeCopy(): void {
  const copy = el('button', 'icon-button code-copy');
  copy.type = 'button';
  copy.hidden = true;
  setTip(copy, 'Copy');
  const done = icon(icons.check);
  done.classList.add('done');
  copy.append(icon(icons.copy), done);
  document.body.append(copy);
  const hide = (): void => { copy.hidden = true; shownOn = undefined; };
  document.addEventListener('mouseover', (event) => {
    if (event.target instanceof Node && copy.contains(event.target)) return;
    const block = codeBlockAt(event.target);
    if (block === undefined) { hide(); return; }
    if (block === shownOn && !copy.hidden) return;
    shownOn = block;
    copy.classList.remove('copied');
    copy.hidden = false;
    const box = block.getBoundingClientRect();
    copy.style.top = box.top + window.scrollY + 4 + 'px';
    copy.style.left = box.right + window.scrollX - copy.offsetWidth - 4 + 'px';
  });
  window.addEventListener('scroll', hide, { passive: true });
  copy.addEventListener('click', () => {
    const text = (shownOn?.querySelector('code') ?? shownOn)?.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 1500);
    }, () => { $('error').textContent = 'Could not copy the code.'; });
  });
}
