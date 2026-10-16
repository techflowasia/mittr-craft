const asNonEmptyString = (value, field) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Mittr session is missing ${field}`);
  return text;
};

/**
 * The only place a payload from Mittr becomes a session the rest of this
 * process trusts. Fields are copied by name, so anything the platform adds
 * later, or anything injected, travels no further than here.
 */
export function parseSession(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Mittr session must be an object');
  }

  const expiresAt = payload.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('Mittr session is missing a numeric expiresAt');
  }

  const subject = payload.subject;
  if (!subject || typeof subject !== 'object') {
    throw new Error('Mittr session is missing subject');
  }

  return {
    accessToken: asNonEmptyString(payload.accessToken, 'accessToken'),
    refreshToken: asNonEmptyString(payload.refreshToken, 'refreshToken'),
    expiresAt,
    subject: {
      userId: asNonEmptyString(subject.userId, 'subject.userId'),
      // A missing display name costs a nicety in the UI, not a sign-in.
      displayName: typeof subject.displayName === 'string' ? subject.displayName : '',
    },
  };
}
