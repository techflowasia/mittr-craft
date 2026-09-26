import nodeFs from 'node:fs';
import path from 'node:path';

// Mittr decides what exists; the developer decides what runs. Only disabled
// entries are recorded, so absence means enabled: a catalog entry that appears
// later is on by default, and a developer's disable survives every sync until
// they undo it themselves (spec §7).
export function createEnablementStore({ filePath, fsImpl = nodeFs }) {
  const load = () => {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const save = (state) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  };

  return {
    isEnabled: (kind, name) => !load()[kind]?.[name]?.disabled,
    setEnabled: (kind, name, enabled) => {
      const state = load();
      state[kind] = state[kind] ?? {};
      if (enabled) delete state[kind][name];
      else state[kind][name] = { disabled: true, at: new Date().toISOString() };
      save(state);
    },
    all: () => load(),
  };
}
