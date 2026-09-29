import { describe, expect, it } from 'vitest';

import {
  MITTRCRAFT_AGENT_TOOL_ACTIONS,
  MITTRCRAFT_CHROME_ACTIONS,
  MITTRCRAFT_COMPUTER_ACTIONS,
  MITTRCRAFT_VOICE_ACTIONS,
  MITTRCRAFT_WEB_ACTIONS,
} from '../mittrcraft-control/actions.js';
import {
  CHROME_PARAMETER_PROPERTIES,
  CONTROL_PARAMETER_PROPERTIES,
  WEB_PARAMETER_PROPERTIES,
} from '../agent-tool/runtime.js';
import { VOICE_ACTION_TITLES, buildVoiceTools } from './tools.js';

const byName = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
const actionEnum = (tool) => tool.parameters.properties.action.enum;

describe('voice tool schemas', () => {
  it('offers the agent control actions, every web capability on this build, and the voice-only actions', () => {
    const tools = byName(buildVoiceTools({ chromeAvailable: true, computerAvailable: true }));
    expect(Object.keys(tools)).toEqual(['mittrcraft', 'mittrcraft_web', 'mittrcraft_voice']);
    expect(actionEnum(tools.mittrcraft)).toEqual([...MITTRCRAFT_AGENT_TOOL_ACTIONS]);
    expect(actionEnum(tools.mittrcraft_web)).toEqual([...MITTRCRAFT_WEB_ACTIONS, ...MITTRCRAFT_CHROME_ACTIONS, ...MITTRCRAFT_COMPUTER_ACTIONS]);
    expect(actionEnum(tools.mittrcraft_voice)).toEqual([...MITTRCRAFT_VOICE_ACTIONS]);
  });

  it('leaves out Chrome and desktop actions this build cannot run', () => {
    const tools = byName(buildVoiceTools({ chromeAvailable: false, computerAvailable: false }));
    expect(actionEnum(tools.mittrcraft_web)).toEqual([...MITTRCRAFT_WEB_ACTIONS]);
  });

  it('has a human title for every action a voice tool can offer', () => {
    for (const tool of buildVoiceTools({ chromeAvailable: true, computerAvailable: true })) {
      for (const action of actionEnum(tool)) expect(VOICE_ACTION_TITLES[action]).toEqual(expect.any(String));
    }
  });

  it('keeps the voice-only actions out of every other tool', () => {
    const tools = buildVoiceTools({ chromeAvailable: true, computerAvailable: true });
    for (const tool of tools.filter(({ name }) => name !== 'mittrcraft_voice')) {
      for (const action of MITTRCRAFT_VOICE_ACTIONS) expect(actionEnum(tool)).not.toContain(action);
    }
  });

  it('uses the parameter schemas the coding agent’s tools use', () => {
    const tools = byName(buildVoiceTools({ chromeAvailable: true, computerAvailable: true }));
    for (const [name, schema] of Object.entries(CONTROL_PARAMETER_PROPERTIES)) {
      expect(tools.mittrcraft.parameters.properties[name]).toEqual(schema);
    }
    expect(tools.mittrcraft_web.parameters.properties.viewport).toEqual(WEB_PARAMETER_PROPERTIES.viewport);
    expect(tools.mittrcraft_web.parameters.properties.goal).toEqual(CHROME_PARAMETER_PROPERTIES.goal);
    expect(tools.mittrcraft_web.parameters.properties.app).toBeDefined();
    expect(Object.keys(tools.mittrcraft_voice.parameters.properties).sort()).toEqual(['action', 'directory', 'sessionId']);
    expect(tools.mittrcraft_voice.parameters.required).toEqual(['action', 'sessionId']);
  });

  it('fits the platform’s size limits', () => {
    for (const tool of buildVoiceTools({ chromeAvailable: true, computerAvailable: true })) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(tool.parameters).length).toBeLessThanOrEqual(30000);
    }
  });
});
