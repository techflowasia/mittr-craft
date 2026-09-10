/**
 * Markdown list continuation for the composer.
 *
 * Writing a list in a plain text box means retyping the marker on every line
 * and counting the numbers yourself, and getting back out of a nested list
 * means deleting indentation by hand. This is the small set of rules that
 * removes both, kept as plain string functions so the behaviour can be read
 * and tested without a CodeMirror instance.
 *
 * Deliberately not here: renumbering the rest of a list after an insertion.
 * Markdown renders `1. 1. 1.` as 1, 2, 3, so a wrong-looking number is a
 * cosmetic detail in the source, while rewriting lines the caret is not on is
 * a surprise.
 */

/** A list marker split into the parts that have to be rebuilt on the next line. */
type Marker = {
    indent: string;
    /** `-`, `*`, `+`, or the number for an ordered item. */
    bullet: string;
    /** `.` or `)` for an ordered item; empty for a bullet. */
    delimiter: string;
    /** The whitespace between the marker and the item's text. */
    spacing: string;
    /** Everything after the marker on that line. */
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

/** The marker text itself, without the indent. */
const markerText = (marker: Marker) => `${marker.bullet}${marker.delimiter}${marker.spacing}`;

/** The marker to open the next item with: bullets repeat, numbers advance. */
const nextMarkerText = (marker: Marker) => {
    if (!marker.delimiter) return markerText(marker);
    const next = Number.parseInt(marker.bullet, 10) + 1;
    return `${next}${marker.delimiter}${marker.spacing}`;
};

/**
 * The indent of the nearest list item above `lineStart` that is shallower than
 * `indent` — the parent this item would outdent to.
 *
 * Read from the document rather than assumed to be a fixed number of spaces,
 * because people indent by two, by four, and by however many the last person
 * used. Outdenting to a parent that is actually there is right whatever the
 * step was; outdenting by a constant is only right when the guess matches.
 */
const parentIndent = (text: string, lineStart: number, indent: string): string | null => {
    const above = text.slice(0, Math.max(lineStart - 1, 0));
    if (lineStart === 0) return null;
    for (const line of above.split('\n').reverse()) {
        const marker = parseMarker(line);
        if (!marker) continue;
        if (marker.indent.length < indent.length) return marker.indent;
    }
    return null;
};

/**
 * The marker an outdented item should carry: the parent list's own marker,
 * advanced. Without this, outdenting out of a nested numbered list would open
 * a `1.` under a parent that was already on `3.`.
 */
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
    /** Where the caret goes; always collapsed. */
    caret: number;
};

/**
 * What pressing the newline key on a list line should do, or `null` when the
 * caret is not somewhere this applies and the editor's own newline should run.
 *
 * Returning `null` rather than an unchanged document matters: the caller only
 * suppresses the default keystroke when something is returned, so every case
 * this does not understand keeps the editor's ordinary behaviour.
 */
export function continueListOnNewline(
    text: string,
    selectionStart: number,
    selectionEnd: number,
): ListContinuation | null {
    // A selection makes the intent ambiguous — replace it, or continue the list
    // it may span? The editor already has an answer for replacing it.
    if (selectionStart !== selectionEnd) return null;

    const caret = selectionStart;
    if (caret < 0 || caret > text.length) return null;

    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const lineBreak = text.indexOf('\n', caret);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    const line = text.slice(lineStart, lineEnd);

    const marker = parseMarker(line);
    if (!marker) return null;

    // Inside the indent or the marker itself, a newline is not continuing an
    // item — it is breaking the line before one has begun.
    const markerEnd = lineStart + marker.indent.length + markerText(marker).length;
    if (caret < markerEnd) return null;

    if (marker.content.trim() === '') {
        // An empty item is how a person says they are done. One level of
        // nesting comes off; at the outermost level the list ends.
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
