import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { mittrEn } from '../strings/mittr.en';
import { mittrT } from '../strings/mittrT';
import { MittrToolsSectionView, MittrToolsSettingsItem, type ToolsActions } from './MittrToolsSection';
import type { MittrTools } from './toolsApi';
import type { ProfilesLoad, ToolsLoad } from './toolsController';

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

const actions: ToolsActions = {
  retry: noop,
  setComputer: noop,
  setChrome: noop,
  setProfile: noop,
  setHeaded: noop,
  removeHost: noop,
  setWidgets: noop,
};

const toolsWith = (chrome: Partial<MittrTools['chrome']> = {}, computer: Partial<MittrTools['computer']> = {}): ToolsLoad => ({
  status: 'ready',
  tools: {
    computer: { offered: true, enabled: true, ...computer },
    chrome: { offered: true, chromeInstalled: true, enabled: true, profile: 'Default', headed: false, approvedHosts: ['jira.acme.test', 'plane.acme.test'], ...chrome },
    canChange: true,
  },
});

const remoteOf = (state: ToolsLoad): ToolsLoad => (state.status === 'ready' ? { ...state, tools: { ...state.tools, canChange: false } } : state);

const LISTED: ProfilesLoad = { status: 'ready', list: [{ directory: 'Default', name: 'Person' }, { directory: 'Profile 1', name: 'Work' }] };

const view = (state: ToolsLoad, profiles: ProfilesLoad = LISTED) => renderToStaticMarkup(
  <I18nProvider><MittrToolsSectionView state={state} profiles={profiles} actions={actions} /></I18nProvider>,
);

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

const PICKER = `aria-label="${mittrT('mittr.tools.chrome.profile')}"`;

describe('MittrCraft tools section', () => {
  test('the section is titled MittrCraft tools and carries both switches with Chrome\'s settings', () => {
    const html = view(toolsWith());
    expect(html).toContain('>MittrCraft tools</h2>');
    expect(html).toContain(`>${mittrT('mittr.tools.computer.label')}</span>`);
    expect(html).toContain(`>${mittrT('mittr.tools.chrome.label')}</span>`);
    expect(html).toContain(PICKER);
    expect(html).toContain('>Person<');
    expect(html).toContain(`>${mittrT('mittr.tools.chrome.headed')}</span>`);
    expect(html).toContain(`>${mittrT('mittr.tools.chrome.sites')}<`);
    expect(html).toContain(mittrT('mittr.tools.chrome.taskNote'));
    expect(html).toContain('a copy of this profile, including your sign-ins, is kept in this Mac&#x27;s temporary folder.');
    expect(mittrT('mittr.tools.chrome.profileCopy')).toContain('including your sign-ins');
    expect(html).toContain(mittrT('mittr.tools.chrome.sitesScope'));
    expect(mittrT('mittr.tools.chrome.sitesScope')).toContain('on this Mac');
  });

  test('a client that is not this Mac sees one line instead of controls', () => {
    const html = view(remoteOf(toolsWith()));
    expect(html).toContain('>MittrCraft tools</h2>');
    expect(html).toContain(mittrT('mittr.tools.changeOnThisMac'));
    expect(mittrT('mittr.tools.changeOnThisMac')).toBe('These settings can be changed only on this Mac.');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('data-slot="button"');
    expect(html).not.toContain(PICKER);
    expect(html).not.toContain(mittrT('mittr.tools.chrome.siteRemoveShort'));
    expect(html).not.toContain('jira.acme.test');
    expect(view(remoteOf(toolsWith({ offered: false }, { offered: false })))).toBe('');
  });

  test('the widgets switch shows where the server offers it, alone or with the other tools', () => {
    const offered = (enabled: boolean): ToolsLoad => {
      const base = toolsWith();
      return base.status === 'ready' ? { ...base, tools: { ...base.tools, widgets: { offered: true, enabled } } } : base;
    };
    const html = view(offered(true));
    expect(html).toContain(`>${mittrT('mittr.tools.widgets.label')}</span>`);
    expect(html).toContain(`aria-label="${mittrT('mittr.tools.widgets.aria')}"`);
    expect(view(toolsWith())).not.toContain(mittrT('mittr.tools.widgets.label'));
    const onlyWidgets = offered(false);
    const alone = onlyWidgets.status === 'ready'
      ? { ...onlyWidgets, tools: { ...onlyWidgets.tools, computer: { offered: false, enabled: false }, chrome: { ...onlyWidgets.tools.chrome, offered: false } } }
      : onlyWidgets;
    expect(view(alone)).toContain('>MittrCraft tools</h2>');
    expect(view(alone)).toContain(`>${mittrT('mittr.tools.widgets.label')}</span>`);
  });

  test('a tool this install cannot run shows no switch', () => {
    const noComputer = view(toolsWith({}, { offered: false }));
    expect(noComputer).not.toContain(mittrT('mittr.tools.computer.label'));
    expect(noComputer).toContain(mittrT('mittr.tools.chrome.label'));

    const noChrome = view(toolsWith({ offered: false }));
    expect(noChrome).toContain(mittrT('mittr.tools.computer.label'));
    expect(noChrome).not.toContain(mittrT('mittr.tools.chrome.label'));
    expect(noChrome).not.toContain(PICKER);
    expect(noChrome).not.toContain(mittrT('mittr.tools.chrome.notInstalled'));
  });

  test('a hosted runtime renders nothing', () => {
    expect(view(toolsWith({ offered: false }, { offered: false }))).toBe('');
    expect(view({ status: 'loading' })).toBe('');
  });

  test('Chrome not installed shows the install line and no switch', () => {
    const html = view(toolsWith({ chromeInstalled: false }));
    expect(html).toContain(mittrT('mittr.tools.chrome.notInstalled'));
    expect(mittrT('mittr.tools.chrome.notInstalled')).toBe('Install Google Chrome to let agents use it.');
    expect(html).not.toContain(mittrT('mittr.tools.chrome.aria'));
    expect(html).not.toContain(PICKER);
    expect(html).not.toContain(mittrT('mittr.tools.chrome.sites'));
  });

  test('Chrome off hides its profile, window and sites', () => {
    const html = view(toolsWith({ enabled: false }), { status: 'idle' });
    expect(html).toContain(mittrT('mittr.tools.chrome.label'));
    expect(html).not.toContain(PICKER);
    expect(html).not.toContain(mittrT('mittr.tools.chrome.headed'));
    expect(html).not.toContain(mittrT('mittr.tools.chrome.sites'));
  });

  test('no Chrome profiles shows the line and no picker', () => {
    const html = view(toolsWith({ profile: null }), { status: 'ready', list: [] });
    expect(html).toContain(mittrT('mittr.tools.chrome.noProfiles'));
    expect(mittrT('mittr.tools.chrome.noProfiles')).toBe('Chrome has no profiles on this Mac.');
    expect(html).not.toContain(PICKER);

    const failed = view(toolsWith(), { status: 'error', error: 'Could not list the Chrome profiles on this Mac' });
    expect(failed).toContain('Could not list the Chrome profiles on this Mac');
    expect(failed).not.toContain(mittrT('mittr.tools.chrome.noProfiles'));
    expect(failed).not.toContain(PICKER);
    expect(failed).toContain(`>${mittrT('mittr.tools.actions.retry')}</button>`);
  });

  test('a stored profile this Mac does not list shows the placeholder, not a folder name', () => {
    const html = view(toolsWith({ profile: 'Profile 9' }));
    expect(html).toContain(PICKER);
    expect(html).toContain(mittrT('mittr.tools.chrome.profilePlaceholder'));
    expect(html).not.toContain('Profile 9');
  });

  test('the allowed sites list each host with Remove', () => {
    const html = view(toolsWith());
    expect(html).toContain('>jira.acme.test</span>');
    expect(html).toContain('>plane.acme.test</span>');
    expect(html).toContain(`aria-label="${mittrT('mittr.tools.chrome.siteRemove', { host: 'jira.acme.test' })}"`);
    expect(html).toContain(`aria-label="${mittrT('mittr.tools.chrome.siteRemove', { host: 'plane.acme.test' })}"`);
    expect(countOf(html, `>${mittrT('mittr.tools.chrome.siteRemoveShort')}</button>`)).toBe(2);

    const empty = view(toolsWith({ approvedHosts: [] }));
    expect(empty).toContain(mittrT('mittr.tools.chrome.sitesEmpty'));
    expect(countOf(empty, `>${mittrT('mittr.tools.chrome.siteRemoveShort')}</button>`)).toBe(0);
  });

  test('a failed read says so with Try again', () => {
    const html = view({ status: 'error', error: 'Could not load the MittrCraft tools settings' });
    expect(html).toContain('>MittrCraft tools</h2>');
    expect(html).toContain('Could not load the MittrCraft tools settings');
    expect(html).toContain(`>${mittrT('mittr.tools.actions.retry')}</button>`);
  });

  test('the copy promises no restart and no control beyond what the tools do', () => {
    const values = Object.entries(mittrEn).filter(([key]) => key.startsWith('mittr.tools.')).map(([, value]) => value);
    expect(values.some((value) => value.includes('restart') && !value.includes('without a restart'))).toBe(false);
    expect(values.some((value) => value.includes('control your whole desktop'))).toBe(false);
    expect(mittrT('mittr.tools.computer.info')).toContain('see your desktop and open or bring apps forward');
    expect(mittrT('mittr.tools.info')).toBe('Changes reach agents without a restart. Turning a tool off stops new calls; a call already running finishes.');
  });

  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');
    const html = view(toolsWith());
    expect(html).toContain('>MittrCraft tools</h2>');
    expect(html).toContain('>Agent computer control</span>');
    expect(html).toContain('>Agent Chrome sessions</span>');
    expect(html).toContain('>Chrome profile<');
    expect(html).toContain('>Show the Chrome window while agents use it</span>');
    expect(html).toContain('>Allowed sites<');
    expect(html).toContain('>Remove</button>');
  });

  test('the settings item fails open: a broken section leaves nothing behind', () => {
    const element = MittrToolsSettingsItem();
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement<{ fallback: React.ReactNode; children: React.ReactNode }>(element)) return;
    expect(element.type).toBe(MittrErrorBoundary);
    expect(element.props.fallback).toBeNull();
  });
});
