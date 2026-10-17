import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'bun:test';
import { arch, platform } from 'node:os';
import { runInNewContext } from 'node:vm';
import type { WebviewHtmlOptions } from './webviewHtml';

mock.module('vscode', () => ({
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
  window: { activeColorTheme: { kind: 2 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
}));

const { getWebviewHtml } = await import('./webviewHtml');

const renderHtml = (options: Partial<WebviewHtmlOptions> = {}, scriptUrl = 'https://webview.test/index.js') => getWebviewHtml({
  webview: {
    cspSource: 'https://webview.test',
    asWebviewUri: () => ({ toString: () => scriptUrl }),
  } as unknown as WebviewHtmlOptions['webview'],
  extensionUri: {} as WebviewHtmlOptions['extensionUri'],
  workspaceFolder: '/workspace/project',
  initialStatus: 'connecting',
  cliAvailable: true,
  ...options,
});

const executeBootstrap = (html: string) => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]);
  assert.equal(scripts.length, 2);
  const appended: Array<{ type?: string; src?: string }> = [];
  const window: Record<string, unknown> = {
    localStorage: { getItem: () => null },
    addEventListener: () => {},
    setTimeout: () => 0,
  };
  const context = {
    window,
    document: {
      getElementById: () => null,
      createElement: () => ({}),
      body: { appendChild: (script: { type?: string; src?: string }) => appended.push(script) },
    },
    URL,
    console: { warn: () => {} },
  };
  runInNewContext(scripts[0], context);
  runInNewContext(`${scripts[1]}\n;window.moduleUrls = { prodEntryUrl, devServerUrl };`, context);
  return { window, appended, scripts };
};

const source = readFileSync(new URL('./webviewHtml.ts', import.meta.url), 'utf8');

describe('VS Code webview bootstrap serialization', () => {
  const hostileStrings = [
    '/workspace/"; window.injected = true; //',
    '", injected: (window.injected = true), ignored: "',
    '</script><script>window.injected = true</script>',
    '</ScRiPt><script>window.injected = true</script>',
    '<!--<script>nested</script>',
    'C:\\Users\\developer\\project\\',
    '/workspace/\'single\' "double" `template` ${expression}',
    '/workspace/ไทย/é/😀/\u2028line\u2029paragraph\nreturn\r\ttab\u0000',
  ];

  for (const value of hostileStrings) {
    test(`round-trips bootstrap strings without executing input: ${JSON.stringify(value)}`, () => {
      const workspaceFolders = [{ name: value, path: value }];
      const { window, scripts } = executeBootstrap(renderHtml({
        workspaceFolder: value,
        workspaceFolders,
        extensionVersion: value,
        initialSessionId: value,
      }));
      assert.deepEqual(JSON.parse(JSON.stringify(window.__VSCODE_CONFIG__)), {
        workspaceFolder: value,
        workspaceFolders,
        theme: 'dark',
        connectionStatus: 'connecting',
        cliAvailable: true,
        extensionVersion: value,
        platform: platform(),
        arch: arch(),
        panelType: 'chat',
        viewMode: 'sidebar',
        initialSessionId: value,
      });
      assert.equal(window.__MITTRCRAFT_HOME__, value);
      assert.equal(window.injected, undefined);
      assert.doesNotMatch(scripts.join(''), /[\u2028\u2029]|<\/script/i);
    });
  }

  for (const options of [
    {},
    { panelType: 'agentManager', cliAvailable: false, initialStatus: 'error' },
    { panelType: 'chat', viewMode: 'editor', initialSessionId: 'session-123', initialStatus: 'connected' },
    { workspaceFolder: '', initialSessionId: '' },
  ] satisfies Partial<WebviewHtmlOptions>[]) {
    test(`preserves normal bootstrap defaults and modes: ${JSON.stringify(options)}`, () => {
      const { window, appended } = executeBootstrap(renderHtml(options));
      const config = JSON.parse(JSON.stringify(window.__VSCODE_CONFIG__));
      assert.equal(config.panelType, options.panelType ?? 'chat');
      assert.equal(config.viewMode, options.viewMode ?? 'sidebar');
      assert.equal(config.initialSessionId, options.initialSessionId || null);
      assert.equal(config.connectionStatus, options.initialStatus ?? 'connecting');
      assert.equal(config.cliAvailable, options.cliAvailable ?? true);
      assert.equal(config.extensionVersion, '');
      assert.deepEqual(config.workspaceFolders, []);
      assert.equal(window.__MITTRCRAFT_HOME__, options.workspaceFolder ?? '/workspace/project');
      assert.deepEqual(appended, [{ type: 'module', src: 'https://webview.test/index.js' }]);
    });
  }

  test('serializes production and development module URLs as inert strings', () => {
    const suffix = '</script><script>window.injected=true</script>"\\\u2028\u2029';
    const scriptUrl = `https://webview.test/${suffix}`;
    const devServerUrl = `https://localhost:5173/${suffix}`;
    const production = executeBootstrap(renderHtml({}, scriptUrl));
    assert.equal(production.appended[0].src, scriptUrl);
    const development = executeBootstrap(renderHtml({ devServerUrl: ` ${devServerUrl}/ ` }, scriptUrl));
    assert.deepEqual(JSON.parse(JSON.stringify(development.window.moduleUrls)), {
      prodEntryUrl: scriptUrl,
      devServerUrl,
    });
    assert.equal(development.appended.length, 0);
    assert.equal(development.window.injected, undefined);
    assert.doesNotMatch(development.scripts.join(''), /[\u2028\u2029]|<\/script/i);
  });
});

describe('VS Code webview content security policy', () => {
  test('allows blob URLs for workers without allowing blob scripts', () => {
    const workerSource = source.match(/const workerSrc = ([^\n]+);/)?.[1] ?? '';
    const scriptSource = source.match(/const scriptSrc = ([^\n]+);/)?.[1] ?? '';

    assert.match(workerSource, /'blob:'/);
    assert.doesNotMatch(scriptSource, /'blob:'/);
    assert.match(source, /worker-src \$\{workerSrc\}/);
  });
});
