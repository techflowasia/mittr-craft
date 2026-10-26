const ROW_CONTROLS = 'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="menu"], [role="checkbox"]';

export function isSessionOpenClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const row = target.closest('[data-session-row]');
  if (!row) return false;
  const control = target.closest(ROW_CONTROLS);
  if (!control || !row.contains(control) || control === row) return !row.querySelector('button[aria-pressed]');
  return control.tagName === 'BUTTON'
    && !control.hasAttribute('aria-label')
    && !control.hasAttribute('aria-pressed')
    && !control.hasAttribute('aria-haspopup');
}
