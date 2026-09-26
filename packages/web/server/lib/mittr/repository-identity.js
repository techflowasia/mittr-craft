// A folder name can itself be confidential — a client's name, an unannounced
// product. Only the remote is reported, and a repository without one is
// reported as nothing at all (spec §8).
export async function resolveRepositoryIdentity(directory, { getRemoteUrl }) {
  let url;
  try {
    url = await getRemoteUrl(directory, 'origin');
  } catch {
    return null;
  }

  const raw = String(url ?? '').trim();
  if (!raw) return null;

  const withoutSuffix = raw.replace(/\.git$/, '');
  const match = withoutSuffix.match(/[:/]([^/:]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}
