/** Script that runs inside the HTML preview frame. */


/**
 * Runs inside the HTML preview frame: reports clicks as source lines, and where commented elements sit.
 * The page injects its source text, so it must not use anything from outside its own body.
 * With `scripts` the file's own scripts run too, and clicks on its controls go to them instead of commenting.
 */
export function frameMain(scripts: boolean): void {
  interface FrameAnchor { readonly key: string; readonly start: number; readonly end: number; readonly source: string; node?: Element }
  const lines = (node: Element): [number, number] => {
    const [start = Number.NaN, end = Number.NaN] = ((node as HTMLElement).dataset.lrLines ?? '').split('-').map(Number);
    return [start, end];
  };
  const control = (event: Event): boolean => scripts && event.target instanceof Element && event.target.closest('a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab]') !== null;
  const target = (event: Event): Element | null => (event.target instanceof Element && !control(event) ? event.target.closest('[data-lr-lines]') : null);
  const style = document.createElement('style');
  style.textContent = '[data-lr-hover]{outline:2px dashed #0078d4!important;outline-offset:1px;cursor:pointer!important}'
    + '[data-lr-sel]{outline:2px solid #0078d4!important;outline-offset:1px;background-color:rgba(0,120,215,.12)!important}'
    + '[data-lr-anchor=local]{outline:2px solid rgba(209,134,22,.75)!important;outline-offset:1px}[data-lr-anchor=github]{outline:2px solid rgba(55,148,255,.75)!important;outline-offset:1px}'
    + '[data-lr-focus]{outline-width:3px!important;background-color:rgba(128,128,128,.15)!important}';
  document.head.append(style);
  if (scripts) {
    // A sandboxed srcdoc frame has an opaque origin, where Chromium throws on any history URL change.
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = History.prototype[name];
      History.prototype[name] = function (this: History, ...args: Parameters<History['pushState']>): void {
        try { original.apply(this, args); } catch { /* the frame keeps its URL */ }
      };
    }
  }
  let hover: Element | null = null;
  let anchors: FrameAnchor[] = [];
  let pending = false;
  const closest = (anchor: FrameAnchor): Element | undefined => {
    let exact: Element | undefined;
    let inner: Element | undefined;
    let size = Infinity;
    let after: Element | undefined;
    let afterStart = Infinity;
    for (const node of document.querySelectorAll('[data-lr-lines]')) {
      const [start, end] = lines(node);
      if (!exact && start === anchor.start && end === anchor.end) exact = node;
      if (start <= anchor.end && anchor.end <= end && end - start <= size) { inner = node; size = end - start; }
      if (start >= anchor.end && start < afterStart) { after = node; afterStart = start; }
    }
    return exact ?? inner ?? after;
  };
  const report = (): void => {
    pending = false;
    const tops: Record<string, number> = {};
    for (const node of document.querySelectorAll('[data-lr-anchor]')) node.removeAttribute('data-lr-anchor');
    for (const anchor of anchors) {
      const node = closest(anchor);
      if (!node) continue;
      anchor.node = node;
      if (anchor.source !== 'draft') node.setAttribute('data-lr-anchor', anchor.source);
      tops[anchor.key] = node.getBoundingClientRect().top + scrollY;
    }
    parent.postMessage({ lrHeight: document.documentElement.scrollHeight, lrAnchors: tops }, '*');
  };
  const schedule = (): void => { if (!pending) { pending = true; setTimeout(report, 30); } };
  new ResizeObserver(schedule).observe(document.documentElement);
  addEventListener('load', schedule);
  addEventListener('mouseover', (event) => {
    const at = target(event);
    hover?.removeAttribute('data-lr-hover');
    hover = at;
    at?.setAttribute('data-lr-hover', '');
  });
  addEventListener('click', (event) => {
    if (control(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const at = target(event);
    if (!at) return;
    const [start, end] = lines(at);
    parent.postMessage({ lrPick: { start, end, extend: event.shiftKey, top: at.getBoundingClientRect().top + scrollY } }, '*');
  }, true);
  addEventListener('submit', (event) => event.preventDefault(), true);
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = (event.data ?? {}) as { anchors?: unknown; focus?: unknown; select?: unknown };
    if (Array.isArray(data.anchors)) { anchors = data.anchors as FrameAnchor[]; schedule(); }
    if ('focus' in data) {
      for (const node of document.querySelectorAll('[data-lr-focus]')) node.removeAttribute('data-lr-focus');
      anchors.find((item) => item.key === data.focus)?.node?.setAttribute('data-lr-focus', '');
    }
    if ('select' in data) for (const node of document.querySelectorAll('[data-lr-sel]')) node.removeAttribute('data-lr-sel');
    if (Array.isArray(data.select)) {
      const [from, to] = data.select as number[];
      for (const node of document.querySelectorAll('[data-lr-lines]')) {
        const [start, end] = lines(node);
        if (from !== undefined && to !== undefined && start >= from && end <= to && !node.parentElement?.closest('[data-lr-sel]')) node.setAttribute('data-lr-sel', '');
      }
    }
  });
  parent.postMessage({ lrReady: true }, '*');
}
