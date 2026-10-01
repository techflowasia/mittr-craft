export function bindEscapeToEnd(target: EventTarget, end: () => void): () => void {
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape' || event.defaultPrevented) return;
    end();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
