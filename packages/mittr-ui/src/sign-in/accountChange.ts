const ACCOUNT_CHANGED_CHANNEL = 'mittr.account.changed';

const thisWindow = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const openChannel = (): BroadcastChannel | null =>
  'BroadcastChannel' in globalThis ? new BroadcastChannel(ACCOUNT_CHANGED_CHANNEL) : null;

export function announceAccountChanged(): void {
  const channel = openChannel();
  channel?.postMessage(thisWindow);
  channel?.close();
}

export function listenAccountChanged(onChange: () => void): () => void {
  const channel = openChannel();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<string>) => {
    if (event.data !== thisWindow) onChange();
  };
  return () => {
    channel.onmessage = null;
    channel.close();
  };
}

let holds = 0;
const releaseListeners = new Set<() => void>();

export function holdGate(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) for (const listener of [...releaseListeners]) listener();
  };
}

export function gateHeld(): boolean {
  return holds > 0;
}

export function onGateRelease(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => { releaseListeners.delete(listener); };
}
