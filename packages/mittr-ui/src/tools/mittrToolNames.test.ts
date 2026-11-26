import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerProductUiPlugin, resetProductUiPluginsForTests } from '../../../ui/src/lib/product-plugins';
import { getToolMetadata } from '../../../ui/src/lib/toolHelpers';
import { MITTR_TOOL_NAMES } from './mittrToolNames';

const registry = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../mittr-server/src/mittr/tools/registry.js'), 'utf8');
const offered = [...(/MITTR_TOOLS = Object\.freeze\(\{([^}]*)\}\)/.exec(registry)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);

afterEach(() => {
  resetProductUiPluginsForTests();
});

describe('names of the Mittr tools in the chat', () => {
  test('every tool the server offers has a name, and none of them shows its raw id', () => {
    expect(offered.length).toBeGreaterThan(0);
    expect(Object.keys(MITTR_TOOL_NAMES).sort()).toEqual(['mittrcraft', ...offered].sort());
    for (const name of Object.values(MITTR_TOOL_NAMES)) expect(/_|mittrcraft/.test(name)).toBe(false);
  });

  test('the chat shows the plugin name, and without the plugin the tool keeps the name made from its id', () => {
    expect(getToolMetadata('mittrcraft_todo').displayName).toBe('Mittrcraft todo');
    registerProductUiPlugin({ id: 'names', toolNames: MITTR_TOOL_NAMES });
    expect(getToolMetadata('mittrcraft_todo').displayName).toBe('Update tasks');
    expect(getToolMetadata('acme_probe').displayName).toBe('Acme probe');
  });
});
