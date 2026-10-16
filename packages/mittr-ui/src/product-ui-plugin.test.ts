import { describe, expect, test } from 'bun:test';

import { dict as enDict } from '../../ui/src/lib/i18n/messages/en';
import { overlayDictionary } from '../../ui/src/lib/product-plugins';
import './product-ui-plugin';
import { strings } from './strings/en';

const MISLEADING = [
  'an MittrCraft',
  'An MittrCraft',
  'MittrCraft MittrCraft',
  'Install MittrCraft',
  'MittrCraft {version}',
  'the the ',
  'your the ',
];

describe('MittrCraft UI plugin', () => {
  const merged = overlayDictionary('en', enDict);

  test('the merged English dictionary names no OpenChamber or OpenCode product', () => {
    const leftovers = Object.entries(merged)
      .filter(([key, value]) => /\bOpenChamber\b/.test(value) && !(key in strings));
    expect(leftovers).toEqual([]);
  });

  test('no merged English value reads as installing or updating the app in place of the engine', () => {
    const offenders = Object.entries(merged)
      .flatMap(([key, value]) => MISLEADING.filter((phrase) => value.includes(phrase)).map((phrase) => `${key}: ${phrase}`));
    expect(offenders).toEqual([]);
  });

  test('the About dialog says only "Version" under the app name and drops the community tagline', () => {
    expect(merged['aboutDialog.openChamberVersionLabel']).toBe('Version {version}');
    expect(merged['aboutDialog.footerNote']).toBe('');
  });

  test('every override keeps the placeholders of the value it replaces', () => {
    const placeholders = (value: string) => (value.match(/\{[^{}]+\}/g) ?? []).sort();
    const changed = Object.entries(strings)
      .filter(([key, value]) => placeholders(value).join() !== placeholders(enDict[key as keyof typeof enDict]).join())
      .map(([key]) => key);
    expect(changed).toEqual([]);
  });
});
