const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const SCP_LIKE = /^(?:[^@/\\\s]+@)?[^@/\\\s:]+:(.*)$/s;

const pathOfRemote = (raw) => {
  if (WITH_SCHEME.test(raw)) {
    try {
      const url = new URL(raw);
      return url.protocol === 'file:' ? null : url.pathname;
    } catch {
      return null;
    }
  }
  if (WINDOWS_PATH.test(raw)) return null;
  return raw.match(SCP_LIKE)?.[1] ?? null;
};

export async function resolveRepositoryIdentity(directory, { remoteUrl }) {
  let url;
  try {
    url = await remoteUrl(directory);
  } catch {
    return null;
  }

  const remotePath = pathOfRemote(String(url ?? '').trim());
  if (!remotePath) return null;

  const segments = remotePath.split('/').filter(Boolean);
  if (segments.length > 0) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '');
  const [owner, repository] = segments.slice(-2);
  return segments.length >= 2 && owner && repository ? `${owner}/${repository}` : null;
}
