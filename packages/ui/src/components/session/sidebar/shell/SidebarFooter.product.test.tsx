import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { registerProductUiPlugin, resetProductUiPluginsForTests } from '@/lib/product-plugins';
import { SidebarFooter } from './SidebarFooter';

const noop = () => {};

const footer = (props: { showRuntimeButtons?: boolean; showUpdateButton?: boolean } = {}) => renderToStaticMarkup(
  <I18nProvider>
    <SidebarFooter
      onOpenSettings={noop}
      onOpenUsage={noop}
      onOpenShortcuts={noop}
      onOpenAbout={noop}
      onOpenUpdate={noop}
      {...props}
    />
  </I18nProvider>,
);

const fillFooter = () => registerProductUiPlugin({
  id: 'footer-probe',
  slots: { 'sidebar-footer': () => <span data-probe="footer">Product footer item</span> },
});

afterEach(() => {
  resetProductUiPluginsForTests();
});

describe('SidebarFooter product slot', () => {
  test('SidebarFooter renders the product slot', () => {
    fillFooter();
    const html = footer({ showUpdateButton: true });
    expect(html).toContain('Product footer item');
    expect(html.indexOf('data-probe="footer"')).toBeLessThan(html.lastIndexOf('<button'));
  });

  test('with no plugin the slot renders nothing', () => {
    expect(footer({ showUpdateButton: false })).not.toContain('data-probe');
    expect(footer({ showRuntimeButtons: false, showUpdateButton: false })).toBe('');
  });

  test('the slot goes with the runtime buttons, which the footer shows by default', () => {
    fillFooter();
    expect(footer({ showUpdateButton: false })).toContain('Product footer item');
    expect(footer({ showRuntimeButtons: false, showUpdateButton: true })).not.toContain('Product footer item');
  });
});
