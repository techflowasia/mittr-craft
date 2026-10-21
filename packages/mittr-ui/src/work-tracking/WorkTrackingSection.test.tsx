import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { mittrT } from '../strings/mittrT';
import type { IntegrationsConfig, PlaneConfig } from './integrationsApi';
import { WORK_TRACKING_LOADING, workTrackingStateFor, type WorkTrackingState } from './workTrackingController';
import { KEEP_PLACEHOLDER } from './workTrackingForm';
import { WorkTrackingSectionView, WorkTrackingSettingsItem, type WorkTrackingActions } from './WorkTrackingSection';

const waitForLocale = async (locale: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = useI18nStore.getState();
    if (state.locale === locale && state.loadingLocale === null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the UI never settled on ${locale}`);
};

afterEach(() => {
  useI18nStore.getState().setLocale(DEFAULT_LOCALE);
});

const noop = () => {};

const actions: WorkTrackingActions = {
  refresh: noop,
  editJira: noop,
  editPlane: noop,
  editNewWorkspace: noop,
  addWorkspace: noop,
  removeWorkspace: noop,
  saveJira: noop,
  savePlane: noop,
  testJira: noop,
  testPlane: noop,
};

const configWith = (plane: Partial<PlaneConfig>, jiraHasToken = true): IntegrationsConfig => ({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', hasToken: jiraHasToken, configured: jiraHasToken },
  plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', hasApiKey: true, configured: true, ...plane },
  userId: 'u-a',
});

const MULTI = configWith({ workspaceSlugs: ['alpha', 'beta'] });

const view = (state: WorkTrackingState) => renderToStaticMarkup(
  <I18nProvider><WorkTrackingSectionView state={state} actions={actions} /></I18nProvider>,
);

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

describe('Work tracking section', () => {
  test('the section is titled Work tracking and lists Jira and Plane', () => {
    const html = view(workTrackingStateFor(MULTI));
    expect(html).toContain('>Work tracking</h2>');
    expect(html).toContain('>Jira<');
    expect(html).toContain('>Plane<');
    expect(countOf(html, `>${mittrT('mittr.workTracking.actions.test')}</button>`)).toBe(2);
  });

  test('a platform without workspaceSlugs shows one workspace and no Add', () => {
    const html = view(workTrackingStateFor(configWith({})));
    expect(html).toContain('>alpha</span>');
    expect(html).toContain(mittrT('mittr.workTracking.plane.singleWorkspace'));
    expect(mittrT('mittr.workTracking.plane.singleWorkspace')).toBe('This Mittr server keeps one Plane workspace.');
    expect(html).not.toContain(`>${mittrT('mittr.workTracking.plane.addWorkspace')}</button>`);
    expect(html).not.toContain(`aria-label="${mittrT('mittr.workTracking.plane.newWorkspace')}"`);

    const multi = view(workTrackingStateFor(MULTI));
    expect(multi).toContain('>alpha</span>');
    expect(multi).toContain('>beta</span>');
    expect(multi).toContain(`>${mittrT('mittr.workTracking.plane.addWorkspace')}</button>`);
    expect(multi).not.toContain(mittrT('mittr.workTracking.plane.singleWorkspace'));
  });

  test('a platform with one workspace and none saved still lets one be added', () => {
    const html = view(workTrackingStateFor(configWith({ workspaceSlug: '', configured: false })));
    expect(html).toContain(mittrT('mittr.workTracking.plane.noWorkspaces'));
    expect(html).toContain(`>${mittrT('mittr.workTracking.plane.addWorkspace')}</button>`);
  });

  test('the saved note says new items can take up to 10 minutes', () => {
    expect(mittrT('mittr.workTracking.savedNote')).toBe('Saved. New items can take up to 10 minutes to show in My work.');
    expect(view(workTrackingStateFor(MULTI))).not.toContain(mittrT('mittr.workTracking.savedNote'));
    const html = view({ ...workTrackingStateFor(MULTI), savedNote: 'plane' });
    expect(countOf(html, mittrT('mittr.workTracking.savedNote'))).toBe(1);
    expect(html.indexOf(mittrT('mittr.workTracking.savedNote'))).toBeGreaterThan(html.indexOf('>Plane<'));
  });

  test('per-workspace test results show one row each', () => {
    const html = view({
      ...workTrackingStateFor(MULTI),
      workspaceTests: {
        alpha: { slug: 'alpha', ok: true, count: 3 },
        beta: { slug: 'beta', ok: false, count: 0, error: 'Forbidden' },
      },
    });
    expect(countOf(html, '<li ')).toBe(2);
    expect(countOf(html, '>3 projects</span>')).toBe(1);
    expect(countOf(html, '>Cannot open: Forbidden</span>')).toBe(1);
    expect(html.indexOf('>3 projects<')).toBeGreaterThan(html.indexOf('>alpha<'));
    expect(html.indexOf('>Cannot open: Forbidden<')).toBeGreaterThan(html.indexOf('>beta<'));
  });

  test('a workspace not saved yet says so instead of a test result', () => {
    const state = workTrackingStateFor(MULTI);
    const html = view({ ...state, plane: { ...state.plane, workspaceSlugs: ['alpha', 'beta', 'gamma'] } });
    expect(countOf(html, mittrT('mittr.workTracking.plane.unsaved'))).toBe(1);
    expect(html.indexOf(mittrT('mittr.workTracking.plane.unsaved'))).toBeGreaterThan(html.indexOf('>gamma<'));
  });

  test('token and key fields are password fields that are never filled', () => {
    const state = workTrackingStateFor(MULTI);
    const html = view(state);
    const passwords = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    expect(passwords).toHaveLength(2);
    for (const field of passwords) {
      expect(field).toContain(`placeholder="${KEEP_PLACEHOLDER}"`);
      expect(field).toContain('value=""');
    }
    expect(countOf(html, mittrT('mittr.workTracking.hasSavedValue'))).toBe(2);

    const none = view(workTrackingStateFor(configWith({ hasApiKey: false, workspaceSlugs: [] }, false)));
    expect(none).not.toContain(KEEP_PLACEHOLDER);
    expect(none).not.toContain(mittrT('mittr.workTracking.hasSavedValue'));
  });

  test('a connection not yet saved cannot be tested', () => {
    const html = view(workTrackingStateFor(configWith({ configured: false }, false)));
    const disabledTests = html.match(new RegExp(`<button[^>]*disabled=""[^>]*>${mittrT('mittr.workTracking.actions.test')}</button>`, 'g')) ?? [];
    expect(disabledTests).toHaveLength(2);
    const ready = view(workTrackingStateFor(MULTI));
    expect(ready.match(new RegExp(`<button[^>]*disabled=""[^>]*>${mittrT('mittr.workTracking.actions.test')}</button>`, 'g'))).toBeNull();
  });

  test('a changed account says so above the form', () => {
    const html = view(workTrackingStateFor(MULTI, mittrT('mittr.workTracking.accountChanged')));
    expect(html.indexOf(mittrT('mittr.workTracking.accountChanged'))).toBeLessThan(html.indexOf('>Jira<'));
  });

  test('while loading or after a failed load there is no form to save', () => {
    const loading = view(WORK_TRACKING_LOADING);
    expect(loading).not.toContain('<input');
    const failed = view({ ...WORK_TRACKING_LOADING, status: 'error', error: 'Sign in to Mittr first' });
    expect(failed).toContain('Sign in to Mittr first');
    expect(failed).not.toContain('<input');
    expect(failed).toContain(`>${mittrT('mittr.workTracking.actions.retry')}</button>`);
  });

  test('a save in progress shows its spinner and cannot be pressed again', () => {
    const html = view({ ...workTrackingStateFor(MULTI), busy: ['saveJira'] });
    expect(countOf(html, 'oc-loader-4')).toBe(1);
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]*?oc-loader-4/.test(html)).toBe(true);
  });

  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');
    const html = view({ ...workTrackingStateFor(configWith({})), savedNote: 'jira' });
    expect(html).toContain('>Work tracking</h2>');
    expect(html).toContain('>Base URL<');
    expect(html).toContain('>API token <span');
    expect(html).toContain('>Personal access token <span');
    expect(html).toContain('This Mittr server keeps one Plane workspace.');
    expect(html).toContain('Saved. New items can take up to 10 minutes to show in My work.');
    expect(html).toContain('>Test connection</button>');
  });

  test('the settings item fails open: a broken section leaves nothing behind', () => {
    const element = WorkTrackingSettingsItem();
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement<{ fallback: React.ReactNode; children: React.ReactNode }>(element)) return;
    expect(element.type).toBe(MittrErrorBoundary);
    expect(element.props.fallback).toBeNull();
    const boundary = new MittrErrorBoundary(element.props);
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('');
  });
});
