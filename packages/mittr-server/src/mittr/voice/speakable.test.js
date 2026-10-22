import assert from 'node:assert/strict';
import test from 'node:test';

import { speakable } from './speakable.js';

test('a spoken reply has no Markdown, code, links or paths', () => {
  assert.equal(speakable('## Done\n\nI fixed **the bug** in `app.js`:\n```js\nconst a = 1;\n```\nSee https://example.test/x and /work/app/src.'), 'Done I fixed the bug in : See a link and');
  assert.equal(speakable('สวัสดีค่ะ แก้ไข *เสร็จแล้ว*'), 'สวัสดีค่ะ แก้ไข เสร็จแล้ว');
  assert.equal(speakable(null), '');
});
