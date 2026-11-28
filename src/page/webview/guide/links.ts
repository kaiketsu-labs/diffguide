/** Hovering a phrase of a chapter's note lights the lines it cites, and hovering those lines lights the phrase. */

interface Lit { readonly phrase: HTMLElement; readonly rows: readonly HTMLElement[] }

let lit: Lit | undefined;

function clear(): void {
  lit?.phrase.classList.remove('lit');
  for (const row of lit?.rows ?? []) row.classList.remove('lit');
  lit = undefined;
}

function light(chapter: HTMLElement, phrase: HTMLElement): void {
  if (lit?.phrase === phrase) return;
  clear();
  const from = Number(phrase.dataset.from);
  const to = Number(phrase.dataset.to);
  const rows = [...chapter.querySelectorAll<HTMLElement>('.chapter-code td.code[data-line]')]
    .filter((cell) => Number(cell.dataset.line) >= from && Number(cell.dataset.line) <= to)
    .flatMap((cell) => cell.parentElement ?? []);
  phrase.classList.add('lit');
  for (const row of rows) row.classList.add('lit');
  lit = { phrase, rows };
}

export function setupChapterLinks(): void {
  document.addEventListener('mouseover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chapter = target?.closest<HTMLElement>('.step-wrap.chapter') ?? null;
    if (target === null || chapter === null) { clear(); return; }
    const phrase = target.closest<HTMLElement>('.chapter-prose .ref');
    if (phrase !== null) { light(chapter, phrase); return; }
    const line = Number(target.closest('.chapter-code tr')?.querySelector<HTMLElement>('td.code[data-line]')?.dataset.line);
    const cited = Number.isNaN(line) ? undefined : [...chapter.querySelectorAll<HTMLElement>('.chapter-prose .ref')]
      .find((ref) => Number(ref.dataset.from) <= line && line <= Number(ref.dataset.to));
    if (cited === undefined) clear(); else light(chapter, cited);
  });
}
