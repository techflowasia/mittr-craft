import React from 'react';

import { Button } from '../../../ui/src/components/ui/button';
import { mittrT, useMittrT, type MittrKey } from '../strings/mittrT';
import type { Widget, WidgetValue as WidgetValueData } from './widgetsApi';

type WidgetCardProps = {
  widget: Widget;
  busy: boolean;
  switchedOn?: boolean;
  now?: number;
  onEnable: (id: string, revision: string) => void;
  onDisable: (id: string) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
};

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

const updatedAt = (at: number, now: number): string => new Intl.DateTimeFormat('en-US', sameDay(at, now)
  ? { hour: '2-digit', minute: '2-digit' }
  : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at);

const shownFile = (file: string, cwd: string): string => (file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);

const statusKey = (value: string): MittrKey | null => {
  if (value === 'ok') return 'mittr.widgets.status.ok';
  if (value === 'warn') return 'mittr.widgets.status.warn';
  if (value === 'fail') return 'mittr.widgets.status.fail';
  return null;
};

function WidgetValue({ value }: { value: WidgetValueData }): React.ReactNode {
  if (value.kind === 'lines') {
    return <ul className="mittr-widget-list">{value.value.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>;
  }
  if (value.kind === 'number') return <span className="mittr-widget-number">{new Intl.NumberFormat('en-US').format(value.value)}</span>;
  const key = statusKey(value.value);
  return (
    <span className="mittr-widget-status" data-tone={key ? value.value : undefined}>
      {key ? mittrT(key) : value.value}
    </span>
  );
}

function WidgetSourceLines({ widget }: { widget: Widget }): React.ReactNode {
  const t = useMittrT();
  const { source } = widget;
  return (
    <>
      <p className="mittr-widget-source-line">
        <span className="mittr-widget-source-kind">{t(source.type === 'url' ? 'mittr.widgets.source.url' : 'mittr.widgets.source.command')}</span>
        <code className="mittr-widget-source">{source.type === 'url' ? source.url : source.command}</code>
      </p>
      {source.type === 'command' ? <p className="mittr-widget-note">{t('mittr.widgets.source.cwd', { cwd: source.cwd })}</p> : null}
      {source.type === 'command' && widget.files.length > 0 ? (
        <p className="mittr-widget-note" data-runs-files="">{t('mittr.widgets.source.files', { files: widget.files.map((file) => shownFile(file, source.cwd)).join(', ') })}</p>
      ) : null}
    </>
  );
}

function WidgetSource({ widget }: { widget: Widget }): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="mittr-widget-source-block">
      {widget.offReason ? <p className="mittr-widget-reason" role="status">{t(widget.offReason === 'files' ? 'mittr.widgets.offReason.files' : 'mittr.widgets.offReason.changed')}</p> : null}
      <p className="mittr-widget-note">{t('mittr.widgets.off', { minutes: widget.refreshMinutes })}</p>
      <WidgetSourceLines widget={widget} />
    </div>
  );
}

function WidgetLast({ widget, now }: { widget: Widget; now: number }): React.ReactNode {
  const t = useMittrT();
  const { last } = widget;
  return (
    <>
      {!last ? <p className="mittr-widget-note">{t('mittr.widgets.notYet')}</p> : null}
      {last && 'error' in last ? <p className="mittr-widget-error" role="alert">{last.error}</p> : null}
      {last && 'value' in last ? <WidgetValue value={last.value} /> : null}
      {last ? <p className="mittr-widget-note">{t('mittr.widgets.updated', { time: updatedAt(last.at, now) })}</p> : null}
      <details className="mittr-widget-source-block">
        <summary className="mittr-widget-note">{t('mittr.widgets.source.summary', { minutes: widget.refreshMinutes })}</summary>
        <WidgetSourceLines widget={widget} />
      </details>
    </>
  );
}

export function WidgetCard({ widget, busy, switchedOn = true, now = Date.now(), onEnable, onDisable, onRefresh, onRemove }: WidgetCardProps): React.ReactNode {
  const t = useMittrT();
  const [confirming, setConfirming] = React.useState(false);
  return (
    <article
      className="mittr-widget"
      data-enabled={widget.enabled ? 'true' : 'false'}
      data-alerting={widget.alerting ? 'true' : 'false'}
      aria-busy={busy}
    >
      <header className="mittr-widget-head">
        <h3 className="mittr-widget-title">{widget.title}</h3>
        {widget.alerting ? <span className="mittr-widget-alerting">{t('mittr.widgets.alerting')}</span> : null}
      </header>
      {widget.enabled ? <WidgetLast widget={widget} now={now} /> : <WidgetSource widget={widget} />}
      {confirming ? (
        <div className="mittr-widget-actions" data-confirm="">
          <span className="mittr-widget-note">{t('mittr.widgets.removeConfirm')}</span>
          <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => { setConfirming(false); onRemove(widget.id); }}>{t('mittr.widgets.removeYes')}</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>{t('mittr.widgets.removeNo')}</Button>
        </div>
      ) : (
        <div className="mittr-widget-actions">
          {widget.enabled ? (
            <>
              <Button type="button" size="xs" variant="outline" disabled={busy || !switchedOn} onClick={() => onRefresh(widget.id)}>{t('mittr.widgets.refresh')}</Button>
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => onDisable(widget.id)}>{t('mittr.widgets.turnOff')}</Button>
            </>
          ) : (
            <Button type="button" size="xs" variant="default" disabled={busy || !switchedOn} onClick={() => onEnable(widget.id, widget.revision)}>{t('mittr.widgets.turnOn')}</Button>
          )}
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t('mittr.widgets.remove')}</Button>
        </div>
      )}
    </article>
  );
}
