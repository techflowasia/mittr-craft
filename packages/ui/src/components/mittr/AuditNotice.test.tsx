import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuditNotice } from './AuditNotice';
import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';

const notice = () => renderToStaticMarkup(
  <I18nProvider>
    <AuditNotice />
  </I18nProvider>,
);

describe('AuditNotice', () => {
  test('says that instructions are recorded and who can read them', () => {
    const html = notice();
    expect(html).toContain('recorded');
    expect(html).toContain('admins');
  });

  test('says in the same breath that code and files are not recorded', () => {
    // Without this half the notice reads as though everything is captured, and
    // people stop using the product for real work.
    const html = notice();
    expect(html).toContain('Your code and files are not');
  });

  test('is a note, so it is announced rather than read as body copy', () => {
    expect(notice()).toContain('role="note"');
  });

  test('carries no wording that would be wrong once the catalog changes', () => {
    // The catalog gate is entitled-to-any: a person can hold a catalog listing
    // two models while being entitled to one. "not in your catalog" would be
    // wrong exactly when the refusal appears.
    expect(dict['mittr.model.refused.entitlement']).not.toContain('catalog');
  });
});
