const LIMITS = Object.freeze({ title: 120, message: 500, detail: 4000, label: 40 });

const textWithin = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

const askable = ({ title, message, detail, confirmLabel, cancelLabel } = {}) => textWithin(title, LIMITS.title)
  && textWithin(message, LIMITS.message)
  && (detail === undefined || (typeof detail === 'string' && detail.length <= LIMITS.detail))
  && textWithin(confirmLabel, LIMITS.label)
  && textWithin(cancelLabel, LIMITS.label);

export const createHostConfirm = ({ dialog, windows, log = console }) => {
  let asking = false;
  return async (question) => {
    if (asking || !askable(question)) return false;
    asking = true;
    try {
      const visible = windows().find((window) => !window.isDestroyed() && window.isVisible());
      if (visible) {
        visible.show();
        visible.focus();
      }
      const options = {
        type: 'question',
        title: question.title,
        message: question.message,
        ...(question.detail ? { detail: question.detail } : {}),
        buttons: [question.cancelLabel, question.confirmLabel],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = visible ? await dialog.showMessageBox(visible, options) : await dialog.showMessageBox(options);
      return result?.response === 1;
    } catch (error) {
      log.warn('[electron] a confirmation dialog failed:', error?.name ?? 'Error');
      return false;
    } finally {
      asking = false;
    }
  };
};
