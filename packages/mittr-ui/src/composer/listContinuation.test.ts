import { describe, expect, test } from 'bun:test';
import { continueListOnNewline, listContinuationEdit } from './listContinuation';

const newline = (source: string) => {
    const caret = source.indexOf('|');
    const text = source.replace('|', '');
    const result = continueListOnNewline(text, caret, caret);
    if (!result) return null;
    return `${result.text.slice(0, result.caret)}|${result.text.slice(result.caret)}`;
};

describe('continuing a bullet list', () => {
    test('opens the next item with the same marker', () => {
        expect(newline('* Test|')).toBe('* Test\n* |');
    });

    test('keeps whichever bullet character was used', () => {
        expect(newline('- Test|')).toBe('- Test\n- |');
        expect(newline('+ Test|')).toBe('+ Test\n+ |');
    });

    test('keeps the nesting depth', () => {
        expect(newline('* Test\n   * หก|')).toBe('* Test\n   * หก\n   * |');
    });

    test('carries the rest of the line onto the new item when the caret is mid-text', () => {
        expect(newline('* Test| 2')).toBe('* Test\n* | 2');
    });
});

describe('continuing a numbered list', () => {
    test('advances the number', () => {
        expect(newline('1. Test ก|')).toBe('1. Test ก\n2. |');
    });

    test('advances from wherever the list has got to, not from one', () => {
        expect(newline('1. Test ก\n2. Test ข\n3. Test ค|')).toBe('1. Test ก\n2. Test ข\n3. Test ค\n4. |');
    });

    test('keeps the delimiter style', () => {
        expect(newline('1) Test|')).toBe('1) Test\n2) |');
    });

    test('numbers a nested list independently of its parent', () => {
        expect(newline('1. Test ก\n   1. Test กข|')).toBe('1. Test ก\n   1. Test กข\n   2. |');
    });
});

describe('leaving a list', () => {
    test('an empty nested item outdents to its parent, continuing the parent list', () => {
        expect(newline('1. Test ก\n   1. Test กข\n   2. |')).toBe('1. Test ก\n   1. Test กข\n2. |');
    });

    test('an empty top-level item ends the list', () => {
        expect(newline('* Test\n* |')).toBe('* Test\n|');
    });

    test('outdents to the parent\'s own indent, whatever step the document used', () => {
        expect(newline('* Test\n      * หก|\n')).toBe('* Test\n      * หก\n      * |\n');
        expect(newline('* Test\n      * |\n')).toBe('* Test\n* |\n');
    });
});

describe('leaving ordinary text alone', () => {
    test('a line that is not a list item', () => {
        expect(newline('just a sentence|')).toBeNull();
    });

    test('a caret inside the marker, where no item has begun yet', () => {
        expect(newline('*| Test')).toBeNull();
        expect(newline('  |* Test')).toBeNull();
    });

    test('a selection, which the editor already knows how to replace', () => {
        expect(continueListOnNewline('* Test', 2, 6)).toBeNull();
    });

    test('a bare asterisk with no space is emphasis, not a bullet', () => {
        expect(newline('*bold*|')).toBeNull();
    });
});

describe('the Shift+Enter edit', () => {
    const apply = (source: string) => {
        const caret = source.indexOf('|');
        const text = source.replace('|', '');
        const edit = listContinuationEdit({ text, selectionStart: caret, selectionEnd: caret });
        if (!edit) return null;
        const next = `${text.slice(0, edit.from)}${edit.insert}${text.slice(edit.to)}`;
        expect(edit.selectionEnd).toBe(edit.selectionStart);
        return `${next.slice(0, edit.selectionStart)}|${next.slice(edit.selectionStart)}`;
    };

    test('inserts only the new line and its marker', () => {
        expect(listContinuationEdit({ text: '1. Test', selectionStart: 7, selectionEnd: 7 })).toEqual({ from: 7, to: 7, insert: '\n2. ', selectionStart: 11, selectionEnd: 11 });
    });

    test('gives the same document as the continuation', () => {
        expect(apply('1. Test ก\n   1. Test กข\n   2. |')).toBe('1. Test ก\n   1. Test กข\n2. |');
        expect(apply('* Test\n* |')).toBe('* Test\n|');
        expect(apply('* Test| 2')).toBe('* Test\n* | 2');
    });

    test('leaves ordinary text to the editor', () => {
        expect(apply('just a sentence|')).toBeNull();
    });
});
