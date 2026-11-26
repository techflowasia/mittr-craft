const ROW_CONTROLS = 'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="menu"], [role="checkbox"]';
const SESSION_TITLE = '[data-session-row-main]';

type OpenTarget = { row: string; title: string; shiftOpensElsewhere: boolean };

const OPEN_TARGETS: readonly OpenTarget[] = [
  { row: '[data-session-row]', title: SESSION_TITLE, shiftOpensElsewhere: true },
  { row: '.group\\/work', title: '[role="button"][aria-label]:not([aria-expanded])', shiftOpensElsewhere: false },
  { row: '.group\\/draft', title: '[role="button"][aria-label]', shiftOpensElsewhere: false },
  { row: '.session-tab-slot[data-active="true"]', title: '[role="tab"]', shiftOpensElsewhere: true },
];

type ClickKeys = { altKey: boolean; shiftKey: boolean };

const PLAIN_CLICK: ClickKeys = { altKey: false, shiftKey: false };

export function isSessionOpenClick(target: EventTarget | null, keys: ClickKeys = PLAIN_CLICK): boolean {
  if (!(target instanceof Element) || keys.altKey) return false;
  for (const { row: selector, title, shiftOpensElsewhere } of OPEN_TARGETS) {
    const row = target.closest(selector);
    if (!row) continue;
    if (keys.shiftKey && shiftOpensElsewhere) return false;
    if (row.querySelector(SESSION_TITLE)?.hasAttribute('aria-pressed')) return false;
    const control = target.closest(ROW_CONTROLS);
    if (!control || !row.contains(control) || control === row) return true;
    return control.matches(title);
  }
  return false;
}
