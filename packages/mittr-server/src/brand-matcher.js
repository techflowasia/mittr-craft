// A `{{id}}` in an entry's `from` stands for one minified identifier, which
// the bundler renames whenever the chunk around it changes. Everything else in
// `from` is matched exactly, and the count rule still holds.
export const ID_TOKEN = '{{id}}';

export const matcherFor = (from) => {
  if (!from.includes(ID_TOKEN)) {
    return { count: (text) => text.split(from).length - 1, replace: (text, to) => text.split(from).join(to) };
  }
  const source = from.split(ID_TOKEN).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z_$][\\w$]*');
  const pattern = new RegExp(source, 'g');
  return { count: (text) => text.match(pattern)?.length ?? 0, replace: (text, to) => text.replace(pattern, () => to) };
};
