import { describe, expect, test } from 'bun:test';
import { bindEscapeToEnd } from './keys';

describe('bindEscapeToEnd', () => {
  const key = (value: string) => Object.assign(new Event('keydown'), { key: value });

  test('Escape anywhere ends the conversation, other keys do not, and unbinding stops it', () => {
    const target = new EventTarget();
    let ended = 0;
    const unbind = bindEscapeToEnd(target, () => {
      ended += 1;
    });
    target.dispatchEvent(key('Enter'));
    target.dispatchEvent(key('Escape'));
    expect(ended).toBe(1);
    unbind();
    target.dispatchEvent(key('Escape'));
    expect(ended).toBe(1);
  });

  test('an Escape another control already handled is left alone', () => {
    const target = new EventTarget();
    let ended = 0;
    bindEscapeToEnd(target, () => {
      ended += 1;
    });
    const handled = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    handled.preventDefault();
    target.dispatchEvent(handled);
    expect(ended).toBe(0);
  });
});
