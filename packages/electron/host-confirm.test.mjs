import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostConfirm } from './host-confirm.mjs';

const QUESTION = Object.freeze({
  title: 'Acme',
  message: 'Turn on acme?',
  detail: 'Reads https://api.example.test/status',
  confirmLabel: 'Turn on',
  cancelLabel: 'Cancel',
});

const fakeWindow = ({ visible = true } = {}) => {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isVisible: () => visible,
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
};

const fakeDialog = (answer) => {
  const shown = [];
  return {
    shown,
    showMessageBox: async (...args) => {
      shown.push(args);
      return typeof answer === 'function' ? answer() : { response: answer };
    },
  };
};

const quiet = { warn: () => {} };

test('a yes is the confirm button, shown on the visible window with cancel as the default', async () => {
  const window = fakeWindow();
  const dialog = fakeDialog(1);
  const confirm = createHostConfirm({ dialog, windows: () => [fakeWindow({ visible: false }), window], log: quiet });

  assert.equal(await confirm(QUESTION), true);
  assert.equal(dialog.shown.length, 1);
  const [parent, options] = dialog.shown[0];
  assert.equal(parent, window);
  assert.deepEqual(window.calls, ['show', 'focus']);
  assert.deepEqual(options, {
    type: 'question',
    title: 'Acme',
    message: 'Turn on acme?',
    detail: 'Reads https://api.example.test/status',
    buttons: ['Cancel', 'Turn on'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
});

test('cancel, closing the dialog or a dialog that fails all answer no', async () => {
  assert.equal(await createHostConfirm({ dialog: fakeDialog(0), windows: () => [], log: quiet })(QUESTION), false);
  assert.equal(await createHostConfirm({ dialog: fakeDialog(() => ({})), windows: () => [], log: quiet })(QUESTION), false);
  const failing = fakeDialog(() => { throw new Error('no display'); });
  assert.equal(await createHostConfirm({ dialog: failing, windows: () => [], log: quiet })(QUESTION), false);
});

test('with no window the dialog is shown on its own', async () => {
  const dialog = fakeDialog(1);
  assert.equal(await createHostConfirm({ dialog, windows: () => [], log: quiet })(QUESTION), true);
  assert.equal(dialog.shown[0].length, 1);
});

test('a question with missing or oversized text is answered no without a dialog', async () => {
  const dialog = fakeDialog(1);
  const confirm = createHostConfirm({ dialog, windows: () => [], log: quiet });
  for (const question of [undefined, {}, { ...QUESTION, message: '' }, { ...QUESTION, confirmLabel: 7 }, { ...QUESTION, title: 'x'.repeat(121) }, { ...QUESTION, detail: 'x'.repeat(4001) }]) {
    assert.equal(await confirm(question), false);
  }
  assert.equal(dialog.shown.length, 0);
});

test('a second question while one is open is answered no and raises no second dialog', async () => {
  let release;
  const dialog = fakeDialog(() => new Promise((resolve) => { release = () => resolve({ response: 1 }); }));
  const confirm = createHostConfirm({ dialog, windows: () => [], log: quiet });
  const first = confirm(QUESTION);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await confirm(QUESTION), false);
  release();
  assert.equal(await first, true);
  assert.equal(dialog.shown.length, 1);
  const next = confirm(QUESTION);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await next, true);
  assert.equal(dialog.shown.length, 2);
});
