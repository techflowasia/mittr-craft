let current: string | null = null;
const listeners = new Set<() => void>();

export function signedInAccount(): string | null {
  return current;
}

export function setSignedInAccount(userId: string | null): void {
  if (userId === current) return;
  current = userId;
  for (const listener of [...listeners]) listener();
}

export function watchSignedInAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
