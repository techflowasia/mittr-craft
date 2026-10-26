export function bindEscapeToEnd(target: EventTarget, end: () => void): () => void {
  const onKey = (event: Event) => {
    if (!('key' in event) || event.key !== 'Escape' || event.defaultPrevented) return;
    end();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
