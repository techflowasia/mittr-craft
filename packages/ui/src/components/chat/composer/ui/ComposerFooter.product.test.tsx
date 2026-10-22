import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { RuntimeAPIs } from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.defineProperty(browser.navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.reject(new Error('no microphone in tests')) },
    configurable: true,
});
Object.defineProperty(browser, 'AudioContext', { value: class {}, configurable: true });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement,
    Event: browser.Event, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser), matchMedia: browser.matchMedia.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
    fetch: () => new Promise<Response>(() => {}),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { registerProductUiPlugin, resetProductUiPluginsForTests, useProductDictationBlock } = await import('@/lib/product-plugins');
const { ComposerFooter } = await import('./ComposerFooter');

type ComposerFooterProps = React.ComponentProps<typeof ComposerFooter>;

const noop = () => {};

const unavailable = (): never => { throw new Error('rendering the footer must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get sourceControl() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
};

const sdk = OpenCode.make({
    baseUrl: 'http://api.example.test',
    fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});

const footerProps = (isMobile: boolean): ComposerFooterProps => ({
    isMobile,
    isVSCode: false,
    sessionId: 'ses_acme',
    directory: '/acme',
    newSessionDraftOpen: false,
    messageLength: 0,
    radius: '12px',
    footerPaddingClass: 'acme-padding',
    footerGapClass: 'acme-gap',
    footerIconButtonClass: 'acme-icon-button',
    iconSizeClass: 'acme-icon-size',
    sendIconSizeClass: 'acme-send-size',
    stopIconSizeClass: 'acme-stop-size',
    canSend: false,
    canAbort: false,
    hasContent: false,
    isExpandedInput: false,
    permissionMode: 'ask',
    isPermissionAutoAcceptInteractive: false,
    dictationActive: false,
    onPickLocalFiles: noop,
    onOpenGitHubPicker: noop,
    onOpenAttachSheet: noop,
    onToggleExpandedInput: noop,
    onCyclePermissionMode: noop,
    onPrimaryAction: noop,
    onQueueMessage: noop,
    onAbort: noop,
    onStartDictation: noop,
    onDictationInsert: noop,
    onDictationInsertAndSend: noop,
    onDictationSendStart: noop,
    onDictationStart: noop,
    onDictationContentHeightChange: noop,
    btwSelection: { agent: undefined, model: null, variant: undefined },
});

const render = async (isMobile: boolean, overrides: Partial<ComposerFooterProps> = {}): Promise<string> => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(
                <RuntimeAPIContext.Provider value={runtimeApis}>
                    <SyncProvider sdk={sdk} directory="/acme">
                        <ThemeSystemProvider>
                            <I18nProvider>
                                <ComposerFooter {...footerProps(isMobile)} {...overrides} />
                            </I18nProvider>
                        </ThemeSystemProvider>
                    </SyncProvider>
                </RuntimeAPIContext.Provider>,
            );
        });
        return container.innerHTML;
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
};

const withoutGeneratedIds = (html: string): string => html.replace(/ (id|aria-controls|aria-describedby|aria-labelledby)="[^"]*"/g, '');

const microphoneButtons = (html: string): string[] => html.split('<button').slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('>')))
    .filter((attributes) => attributes.includes('aria-label="Start dictation"') || attributes.includes('data-acme-mic'));

const micButtonOf = (html: string): string => {
    const start = html.lastIndexOf('<button', html.indexOf('mic'));
    return html.slice(start, html.indexOf('>', start) + 1);
};

function AcmeAction(props: { isMobile: boolean; footerIconButtonClass: string; iconSizeClass: string; dictationActive: boolean }): React.ReactNode {
    return (
        <button type="button" data-acme-action={props.isMobile ? 'mobile' : 'desktop'} className={props.footerIconButtonClass}>
            <span className={props.iconSizeClass}>acme_action</span>
        </button>
    );
}

function AcmeBlockedReason(): React.ReactNode {
    const block = useProductDictationBlock();
    return block.blocked ? <span data-acme-reason>{block.reason}</span> : null;
}

const ACME_REASON = 'Acme dictation is paused until noon';

beforeEach(() => {
    useConfigStore.setState({ dictationEnabled: true });
});

afterEach(() => {
    resetProductUiPluginsForTests();
});

afterAll(() => {
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

describe('the composer-actions slot', () => {
    test("a plugin's composer action renders beside the microphone on desktop and on mobile", async () => {
        registerProductUiPlugin({ id: 'acme', slots: { 'composer-actions': AcmeAction } });

        const desktop = await render(false);
        expect(desktop).toContain('data-acme-action="desktop"');
        expect(desktop).toContain('<span class="acme-icon-size">acme_action</span>');
        expect(desktop.indexOf('data-acme-action')).toBeGreaterThan(desktop.indexOf('aria-label="Start dictation"'));
        expect(desktop.indexOf('data-acme-action')).toBeLessThan(desktop.indexOf('aria-label="Send message"'));

        const mobile = await render(true);
        expect(mobile).toContain('data-acme-action="mobile"');
        expect(mobile.indexOf('data-acme-action')).toBeGreaterThan(mobile.indexOf('aria-label="Start dictation"'));
        expect(mobile.indexOf('data-acme-action')).toBeLessThan(mobile.indexOf('aria-label="Send message"'));
    });

    test('the side-question composer renders no composer action', async () => {
        registerProductUiPlugin({ id: 'acme', slots: { 'composer-actions': AcmeAction } });

        expect(await render(false, { isBtw: true })).not.toContain('data-acme-action');
        expect(await render(true, { isBtw: true })).not.toContain('data-acme-action');
    });

    test('without a plugin the footer has no extra element and the microphone is enabled', async () => {
        for (const isMobile of [false, true]) {
            const html = await render(isMobile);
            expect(html).not.toContain('data-acme-action');
            const mics = microphoneButtons(html);
            expect(mics).toHaveLength(1);
            expect(mics[0]).not.toContain('disabled');
        }
        for (const isMobile of [false, true]) {
            const bare = withoutGeneratedIds(await render(isMobile));
            registerProductUiPlugin({ id: 'acme' });
            expect(withoutGeneratedIds(await render(isMobile))).toBe(bare);
            resetProductUiPluginsForTests();
        }
    });

    test('a plugin that blocks dictation disables both microphone buttons and names the reason', async () => {
        registerProductUiPlugin({
            id: 'acme',
            slots: { 'composer-actions': AcmeBlockedReason },
            composer: { useDictationBlock: () => ({ blocked: true, reason: ACME_REASON }) },
        });

        const desktop = await render(false);
        expect(microphoneButtons(desktop)[0]).toContain('disabled');
        expect(desktop).toContain(`<span data-acme-reason="true">${ACME_REASON}</span>`);

        const mobile = await render(true);
        const mobileMic = micButtonOf(mobile);
        expect(mobileMic).toContain('disabled');
        expect(mobileMic).toContain(`title="${ACME_REASON}"`);
        expect(mobileMic).toContain(`aria-label="${ACME_REASON}"`);
    });

    test('a plugin whose block hook throws leaves dictation enabled', async () => {
        registerProductUiPlugin({
            id: 'acme',
            slots: { 'composer-actions': AcmeBlockedReason },
            composer: { useDictationBlock: () => { throw new Error('acme block failed'); } },
        });

        for (const isMobile of [false, true]) {
            const html = await render(isMobile);
            expect(html).not.toContain('data-acme-reason');
            const mics = microphoneButtons(html);
            expect(mics).toHaveLength(1);
            expect(mics[0]).not.toContain('disabled');
        }
    });

    test('a block plugin registered after the footer rendered is ignored until reload', async () => {
        await render(false);
        registerProductUiPlugin({
            id: 'acme',
            composer: { useDictationBlock: () => ({ blocked: true, reason: ACME_REASON }) },
        });

        expect(microphoneButtons(await render(false))[0]).not.toContain('disabled');
    });
});
