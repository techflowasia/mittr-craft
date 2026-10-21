const isNonEmptyText = (item) => item === String(item) && item !== '';

const hasCommand = (raw) => Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every(isNonEmptyText);

const hasUrl = (raw) => Boolean(raw.url?.trim?.());

export const catalogMcpEntity = (raw, toEntity) => {
  if (raw?.type === 'local' && hasCommand(raw)) return toEntity(raw);
  if (raw?.type === 'remote' && hasUrl(raw)) return toEntity(raw);
  return null;
};
