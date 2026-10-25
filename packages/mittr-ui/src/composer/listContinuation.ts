import type { ComposerEdit, ComposerTextState } from '@/lib/product-plugins';

type Marker = {
  indent: string;
  bullet: string;
  delimiter: string;
  spacing: string;
  content: string;
};

const UNORDERED = /^(\s*)([-*+])([ \t]+)(.*)$/;
const ORDERED = /^(\s*)(\d+)([.)])([ \t]+)(.*)$/;

const parseMarker = (line: string): Marker | null => {
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const [, indent, bullet, delimiter, spacing, content] = ordered;
    return { indent, bullet, delimiter, spacing, content };
  }
  const unordered = UNORDERED.exec(line);
  if (unordered) {
    const [, indent, bullet, spacing, content] = unordered;
    return { indent, bullet, delimiter: '', spacing, content };
  }
  return null;
};

const markerText = (marker: Marker) => `${marker.bullet}${marker.delimiter}${marker.spacing}`;

const nextMarkerText = (marker: Marker) => {
  if (!marker.delimiter) return markerText(marker);
  const next = Number.parseInt(marker.bullet, 10) + 1;
  return `${next}${marker.delimiter}${marker.spacing}`;
};

const parentIndent = (text: string, lineStart: number, indent: string): string | null => {
  if (lineStart === 0) return null;
  const above = text.slice(0, lineStart - 1);
  for (const line of above.split('\n').reverse()) {
    const marker = parseMarker(line);
    if (!marker) continue;
    if (marker.indent.length < indent.length) return marker.indent;
  }
  return null;
};

const nextMarkerAtParent = (text: string, lineStart: number, parent: string): string => {
  if (lineStart === 0) return '';
  for (const line of text.slice(0, lineStart - 1).split('\n').reverse()) {
    const marker = parseMarker(line);
    if (!marker) continue;
    if (marker.indent.length === parent.length) return nextMarkerText(marker);
    if (marker.indent.length < parent.length) break;
  }
  return '';
};

export type ListContinuation = {
  text: string;
  caret: number;
};

export function continueListOnNewline(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): ListContinuation | null {
  if (selectionStart !== selectionEnd) return null;

  const caret = selectionStart;
  if (caret < 0 || caret > text.length) return null;

  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const lineBreak = text.indexOf('\n', caret);
  const lineEnd = lineBreak === -1 ? text.length : lineBreak;
  const line = text.slice(lineStart, lineEnd);

  const marker = parseMarker(line);
  if (!marker) return null;

  const markerEnd = lineStart + marker.indent.length + markerText(marker).length;
  if (caret < markerEnd) return null;

  if (marker.content.trim() === '') {
    const parent = parentIndent(text, lineStart, marker.indent);
    const replacement = parent === null ? '' : `${parent}${nextMarkerAtParent(text, lineStart, parent)}`;
    return {
      text: `${text.slice(0, lineStart)}${replacement}${text.slice(lineEnd)}`,
      caret: lineStart + replacement.length,
    };
  }

  const opened = `${marker.indent}${nextMarkerText(marker)}`;
  return {
    text: `${text.slice(0, caret)}\n${opened}${text.slice(caret)}`,
    caret: caret + 1 + opened.length,
  };
}

export const listContinuationEdit = (state: ComposerTextState): ComposerEdit | null => {
  const continued = continueListOnNewline(state.text, state.selectionStart, state.selectionEnd);
  if (!continued) return null;
  const before = state.text;
  const after = continued.text;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
    selectionStart: continued.caret,
    selectionEnd: continued.caret,
  };
};
