import { afterEach, describe, expect, it } from 'vitest';

import { bundledBinaryCandidates } from './computer-control.js';

describe('bundledBinaryCandidates', () => {
  const originalEnvVar = process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR;
  const originalResourcesPath = process.resourcesPath;

  afterEach(() => {
    if (originalEnvVar === undefined) delete process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR;
    else process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR = originalEnvVar;
    process.resourcesPath = originalResourcesPath;
  });

  it('always includes the monorepo-relative packages/electron/resources copy as a fallback', () => {
    delete process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR;
    process.resourcesPath = undefined;

    const candidates = bundledBinaryCandidates();
    expect(candidates.some((candidate) => candidate.endsWith('packages/electron/resources/cua-driver/cua-driver'))).toBe(true);
  });

  it('tries the env override and process.resourcesPath before the dev fallback', () => {
    process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR = '/from/env';
    process.resourcesPath = '/from/packaged/app';

    const candidates = bundledBinaryCandidates();
    expect(candidates[0]).toBe('/from/env/cua-driver');
    expect(candidates[1]).toBe('/from/packaged/app/cua-driver/cua-driver');
    expect(candidates[2].endsWith('packages/electron/resources/cua-driver/cua-driver')).toBe(true);
  });

  it('drops process.resourcesPath from the list when it is not a string, as in a plain (non-Electron) process', () => {
    delete process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR;
    process.resourcesPath = undefined;

    const candidates = bundledBinaryCandidates();
    expect(candidates).toHaveLength(1);
  });
});
