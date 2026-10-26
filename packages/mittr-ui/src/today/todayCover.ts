const LAUNCHER_INPUT = '.mittr-today-input';

export function coverMainSiblings(section: HTMLElement): () => void {
  const parent = section.parentElement;
  if (!parent) return () => {};
  const covered = new Set<Element>();

  const cover = (): void => {
    for (const child of Array.from(parent.children)) {
      if (child === section || covered.has(child) || child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      covered.add(child);
    }
  };

  const focusLauncher = (): void => {
    section.querySelector<HTMLElement>(LAUNCHER_INPUT)?.focus({ preventScroll: true });
  };

  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof Node && [...covered].some((child) => child.contains(target))) focusLauncher();
  };

  cover();
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(cover) : null;
  observer?.observe(parent, { childList: true });
  document.addEventListener('focusin', onFocusIn, true);
  if (!section.contains(document.activeElement)) focusLauncher();

  return () => {
    observer?.disconnect();
    document.removeEventListener('focusin', onFocusIn, true);
    for (const child of covered) child.removeAttribute('inert');
    covered.clear();
  };
}
