import { isRecord } from './values.js';

// The engine's two spellings of a model choice: `provider/model#variant`, or
// `{ providerID, model, variant }`.
const SHORT_SELECTION = /^([^/#]+)\/([^#]+)(?:#[^#]+)?$/;

// `null` for no default, `undefined` for one this code cannot read.
const readSelection = (model) => {
  if (model === undefined || model === null) return null;
  if (typeof model === 'string') {
    const trimmed = model.trim();
    if (!trimmed) return null;
    const match = SHORT_SELECTION.exec(trimmed);
    return match ? { providerId: match[1], modelId: match[2] } : undefined;
  }
  if (isRecord(model) && typeof model.providerID === 'string' && typeof model.model === 'string') {
    return { providerId: model.providerID, modelId: model.model };
  }
  return undefined;
};

/**
 * Keeps the engine's default model on a provider's models where that
 * provider owns the default, in the user's OpenCode config: no default
 * becomes `<provider>/<first offered id>`; a default on this provider that
 * is no longer offered moves to the first offered id, or is removed when
 * none is offered. A default on any other provider, or one in a form the
 * engine would not read, is never touched. Returns whether it wrote.
 *
 * The user layer, not the managed one, so a default the person picks later
 * is never outranked by a layer above theirs.
 */
export function syncDefaultModel({ userConfig, providerId, modelIds }) {
  const config = userConfig.read();
  const current = readSelection(config.model);
  if (current === undefined) return false;
  const owned = current !== null && current.providerId === providerId;
  if (current !== null && !owned) return false;

  if (modelIds.length === 0) {
    if (!owned) return false;
    delete config.model;
  } else if (!owned || !modelIds.includes(current.modelId)) {
    config.model = `${providerId}/${modelIds[0]}`;
  } else {
    return false;
  }
  userConfig.write(config);
  return true;
}
