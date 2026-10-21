import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { mittrT } from '../strings/mittrT';
import { MyWorkButton, MyWorkFooterItem } from './MyWorkButton';

describe('My work button', () => {
  test('the footer button is a briefcase named My work, with the panel closed', () => {
    expect(mittrT('mittr.work.open')).toBe('My work');
    const html = renderToStaticMarkup(<I18nProvider><MyWorkButton /></I18nProvider>);
    expect(html).toContain(`aria-label="${mittrT('mittr.work.open')}"`);
    expect(html).toContain('oc-briefcase');
    expect(html).not.toContain(mittrT('mittr.work.description'));
  });

  test('the footer item fails open: a broken button leaves nothing behind', () => {
    const element = MyWorkFooterItem();
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement<{ fallback: React.ReactNode; children: React.ReactNode }>(element)) return;
    expect(element.type).toBe(MittrErrorBoundary);
    expect(element.props.fallback).toBeNull();
    const boundary = new MittrErrorBoundary(element.props);
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('');
  });
});
