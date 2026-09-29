import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';

const helpers = createSettingsHelpers({
  normalizePathForPersistence: (value) => value,
  normalizeDirectoryPath: (value) => value,
  normalizeTunnelBootstrapTtlMs: (value) => value,
  normalizeTunnelSessionTtlMs: (value) => value,
  normalizeTunnelProvider: (value) => value,
  normalizeTunnelMode: (value) => value,
  normalizeOptionalPath: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: () => undefined,
  normalizeManagedRemoteTunnelPresetTokens: () => undefined,
  sanitizeTypographySizesPartial: () => undefined,
  normalizeStringArray: (input) => input,
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeProjects: () => undefined,
});

describe('voice settings', () => {
  it('keeps mittr as a speech-to-text provider', () => {
    expect(helpers.sanitizeSettingsUpdate({ sttProvider: 'mittr' })).toEqual({ sttProvider: 'mittr' });
  });

  it('keeps a voice step cap inside 1..20 and drops anything else', () => {
    expect(helpers.sanitizeSettingsUpdate({ voiceStepCap: 8 })).toEqual({ voiceStepCap: 8 });
    expect(helpers.sanitizeSettingsUpdate({ voiceStepCap: 0 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ voiceStepCap: 21 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ voiceStepCap: 3.5 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ voiceStepCap: '8' })).toEqual({});
  });

  it('keeps a spoken reply length inside 1000..30000 and drops anything else', () => {
    expect(helpers.sanitizeSettingsUpdate({ voiceReplyMaxChars: 8000 })).toEqual({ voiceReplyMaxChars: 8000 });
    expect(helpers.sanitizeSettingsUpdate({ voiceReplyMaxChars: 999 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ voiceReplyMaxChars: 30001 })).toEqual({});
  });
});
