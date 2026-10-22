import { pinAccount } from '../tools/account-guard.js';
import { MittrToolError } from '../tools/registry.js';
import { extractValue } from './widget-sources.js';
import { MIN_REFRESH_MINUTES, sourceSignature } from './widget-store.js';

export const TICK_MS = 60_000;
export const TURN_ON_FIRST = 'Turn the widget on first, from Today';
export const WIDGETS_OFF = 'The widgets tool is turned off in Settings → Integrations';

const MINUTE_MS = 60_000;

const errorText = (error) => (error instanceof Error && error.message ? error.message : 'The widget could not refresh');

export const alertHolds = (alert, value) => {
  if (!alert || value === undefined || Array.isArray(value)) return false;
  if (alert.op === 'above') return Number.isFinite(value) && value > alert.value;
  if (alert.op === 'below') return Number.isFinite(value) && value < alert.value;
  if (Number.isFinite(alert.value)) return Number(value) === alert.value;
  return String(value).trim().toLowerCase() === String(alert.value).trim().toLowerCase();
};

export function createWidgetRunner({ store, sources, activeAccountKey, engineOnActiveHome, switchedOn, notify = async () => {}, now = Date.now, logger = console }) {
  const inFlight = new Map();
  let generation = 0;
  let timer = null;

  const isDue = (widget, at) => {
    if (widget.enabled !== true || inFlight.has(widget.id)) return false;
    const every = Math.max(MIN_REFRESH_MINUTES, widget.refreshMinutes) * MINUTE_MS;
    return !widget.last || at - widget.last.at >= every;
  };

  const run = async (key, widget) => {
    const ensureSameAccount = pinAccount({ activeAccountKey, engineOnActiveHome });
    ensureSameAccount(key);
    const started = generation;
    const controller = new AbortController();
    const signature = sourceSignature(widget.source);
    const running = (async () => {
      let outcome;
      try {
        const answer = await sources[widget.source.type](widget.source, { signal: controller.signal });
        outcome = extractValue(answer?.text, widget.source.extract ?? {}, widget.display);
      } catch (error) {
        outcome = { error: errorText(error) };
      }
      if (controller.signal.aborted || started !== generation) return null;
      try {
        ensureSameAccount(key);
      } catch {
        return null;
      }
      const last = outcome.error === undefined ? { at: now(), value: outcome.value } : { at: now(), error: outcome.error };
      const alerting = outcome.error === undefined ? alertHolds(widget.alert, outcome.value) : widget.alerting === true;
      const recorded = store.record(key, widget.id, { signature, last, alerting });
      if (recorded?.rose) {
        await Promise.resolve().then(() => notify(recorded.widget)).catch((error) => {
          logger.warn('[mittr] a widget alert could not be shown as a notification:', error?.name ?? 'Error');
        });
      }
      return recorded?.widget ?? null;
    })();
    inFlight.set(widget.id, { controller, running });
    try {
      return await running;
    } finally {
      if (inFlight.get(widget.id)?.controller === controller) inFlight.delete(widget.id);
    }
  };

  const stop = (id) => {
    inFlight.get(id)?.controller.abort();
    inFlight.delete(id);
  };

  const stopAll = () => {
    generation += 1;
    for (const id of [...inFlight.keys()]) stop(id);
  };

  const ready = async () => {
    const key = activeAccountKey();
    if (!key || engineOnActiveHome() !== true) return null;
    return (await switchedOn()) ? key : null;
  };

  const tick = async () => {
    const started = generation;
    const key = await ready();
    if (!key || started !== generation) return;
    const at = now();
    const due = store.list(key).filter((widget) => isDue(widget, at));
    await Promise.all(due.map((widget) => run(key, widget).catch((error) => {
      logger.warn('[mittr] a widget refresh did not run:', error?.name ?? 'Error');
    })));
  };

  const refresh = async (key, id) => {
    if (!(await switchedOn())) throw new MittrToolError(WIDGETS_OFF, 409);
    const widget = store.get(key, id);
    if (!widget) throw new MittrToolError(`There is no widget ${id}`, 404);
    if (widget.enabled !== true) throw new MittrToolError(TURN_ON_FIRST, 409);
    const pending = inFlight.get(id);
    if (pending) await pending.running.catch(() => null);
    else await run(key, widget);
    return store.get(key, id);
  };

  return {
    tick,
    refresh,
    stop,
    stopAll,
    accountChanged: stopAll,
    switchChanged: (switches) => {
      if (switches?.widgets === false) stopAll();
      else void tick();
    },
    start: (intervalMs = TICK_MS) => {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    dispose: () => {
      clearInterval(timer);
      timer = null;
      stopAll();
    },
  };
}
