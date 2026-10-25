import { afterEach, describe, expect, test } from 'bun:test';

import { registerProductUiPlugin, resetProductUiPluginsForTests } from '@/lib/product-plugins';
import { shiftEnterEdit, type ShiftEnterInput } from '../shiftEnterEdit';

const press = (over: Partial<ShiftEnterInput> = {}): ShiftEnterInput => ({
  key: 'Enter',
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isMobile: false,
  isDesktopExpanded: false,
  enterToSend: true,
  enterToSendConfigured: false,
  inputMode: 'normal',
  autocompleteOpen: false,
  text: '- acme',
  selectionStart: 6,
  selectionEnd: 6,
  ...over,
});

const acmeEdit = { from: 6, to: 6, insert: '\n- ', selectionStart: 9, selectionEnd: 9 };

const fill = () => registerProductUiPlugin({
  id: 'acme',
  composerShiftEnter: (state) => (state.text.startsWith('- ') ? acmeEdit : null),
});

afterEach(() => {
  resetProductUiPluginsForTests();
});

describe('shiftEnterEdit', () => {
  test('with no plugin Shift+Enter is left to the editor', () => {
    expect(shiftEnterEdit(press())).toBeNull();
  });

  test("a plugin's edit answers Shift+Enter when it would break the line", () => {
    fill();
    expect(shiftEnterEdit(press())).toEqual(acmeEdit);
    expect(shiftEnterEdit(press({ isMobile: true }))).toEqual(acmeEdit);
    expect(shiftEnterEdit(press({ isDesktopExpanded: true }))).toEqual(acmeEdit);
  });

  test('a plugin that has nothing to say leaves the editor its newline', () => {
    fill();
    expect(shiftEnterEdit(press({ text: 'acme', selectionStart: 4, selectionEnd: 4 }))).toBeNull();
  });

  test('plain Enter and every modified Enter stay upstream', () => {
    fill();
    expect(shiftEnterEdit(press({ shiftKey: false }))).toBeNull();
    expect(shiftEnterEdit(press({ ctrlKey: true }))).toBeNull();
    expect(shiftEnterEdit(press({ metaKey: true }))).toBeNull();
    expect(shiftEnterEdit(press({ altKey: true }))).toBeNull();
    expect(shiftEnterEdit(press({ key: 'a' }))).toBeNull();
  });

  test('Shift+Enter that sends stays a send', () => {
    fill();
    expect(shiftEnterEdit(press({ enterToSendConfigured: true, enterToSend: false }))).toBeNull();
  });

  test('shell mode and an open picker keep their own Enter', () => {
    fill();
    expect(shiftEnterEdit(press({ inputMode: 'shell' }))).toBeNull();
    expect(shiftEnterEdit(press({ autocompleteOpen: true }))).toBeNull();
  });

  test('the first plugin with an answer wins, and one that throws is skipped', () => {
    registerProductUiPlugin({ id: 'acme-broken', composerShiftEnter: () => { throw new Error('acme'); } });
    registerProductUiPlugin({ id: 'acme-quiet', composerShiftEnter: () => null });
    fill();
    expect(shiftEnterEdit(press())).toEqual(acmeEdit);
  });
});
