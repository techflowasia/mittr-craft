export class MittrCraftControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'MittrCraftControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof MittrCraftControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new MittrCraftControlError(message || fallbackMessage, Number(error?.statusCode) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
