import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import { OtherProvidersSwitchView, type OtherProvidersSwitchViewProps } from './OtherProvidersSwitch';

const noop = () => {};

const view = (props: Partial<OtherProvidersSwitchViewProps> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <OtherProvidersSwitchView checked={false} known saving={false} outcome={null} onCheckedChange={noop} {...props} />
  </I18nProvider>,
);

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const switchTag = (html: string) => html.match(/<[^>]*role="switch"[^>]*>/)?.[0] ?? '';

describe('OtherProvidersSwitchView', () => {
  test('a labelled switch, off, with the note that prompts can go to those providers', () => {
    const html = view();
    expect(html).toContain(escaped(mittrT('mittr.providers.otherProviders.label')));
    expect(html).toContain(escaped(mittrT('mittr.providers.otherProviders.note')));
    const tag = switchTag(html);
    expect(tag).not.toBe('');
    expect(tag).toContain('aria-checked="false"');
    expect(tag).toContain(`aria-label="${escaped(mittrT('mittr.providers.otherProviders.label'))}"`);
    expect(tag).not.toContain('aria-disabled="true"');
  });

  test('on shows checked', () => {
    expect(switchTag(view({ checked: true }))).toContain('aria-checked="true"');
  });

  test('before the stored value is known, or while saving, the switch cannot be pressed', () => {
    expect(switchTag(view({ known: false }))).toContain('aria-disabled="true"');
    expect(switchTag(view({ saving: true }))).toContain('aria-disabled="true"');
    expect(switchTag(view({ saving: true }))).toContain('aria-busy="true"');
  });

  test('a failed or partly applied save says so', () => {
    expect(view({ outcome: 'failed' })).toContain(escaped(mittrT('mittr.providers.otherProviders.saveFailed')));
    expect(view({ outcome: 'not-applied' })).toContain(escaped(mittrT('mittr.providers.otherProviders.notApplied')));
    const quiet = view({ outcome: 'saved' });
    expect(quiet).not.toContain(escaped(mittrT('mittr.providers.otherProviders.saveFailed')));
    expect(quiet).not.toContain(escaped(mittrT('mittr.providers.otherProviders.notApplied')));
  });
});
