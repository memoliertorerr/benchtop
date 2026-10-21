import { describe, expect, it } from 'vitest';
import { type Edit, find, indent, lineOf, newline, PY_INDENT } from './edit-ops.ts';

/** Applies an edit; returns the text with [ and ] around the selection. */
function apply(text: string, edit: Edit): string {
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return `${next.slice(0, edit.selStart)}[${next.slice(edit.selStart, edit.selEnd)}]${next.slice(edit.selEnd)}`;
}

/** Splits "te[xt]" into the text and its selection. */
function sel(marked: string): [string, number, number] {
  const a = marked.indexOf('[');
  const b = marked.indexOf(']') - 1;
  return [marked.replace('[', '').replace(']', ''), a, b];
}

describe('code editor operations (BT42)', () => {
  it('Tab inserts an indent at the caret', () => {
    const [text, a, b] = sel('ab[]c');
    expect(apply(text, indent(text, a, b, false))).toBe('ab  []c');
  });

  it('Tab and Shift-Tab indent and unindent every selected line', () => {
    const [text, a, b] = sel('x\nfo[o\nbar\n]baz');
    expect(apply(text, indent(text, a, b, false))).toBe('x\n  fo[o\n  bar\n]baz');
    const [t2, a2, b2] = sel('  fo[o\n  bar]\nbaz');
    expect(apply(t2, indent(t2, a2, b2, true))).toBe('fo[o\nbar]\nbaz');
    // Shift-Tab with a caret unindents its line.
    const [t3, a3, b3] = sel('    x[]y');
    expect(apply(t3, indent(t3, a3, b3, true))).toBe('  x[]y');
  });

  it('Enter keeps the indentation, adds a level after {, and puts a following } on its own line', () => {
    const [t1, a1, b1] = sel('  int x;[]');
    expect(apply(t1, newline(t1, a1, b1))).toBe('  int x;\n  []');
    const [t2, a2, b2] = sel('void loop() {[]');
    expect(apply(t2, newline(t2, a2, b2))).toBe('void loop() {\n  []');
    const [t3, a3, b3] = sel('  if (x) {[]}');
    expect(apply(t3, newline(t3, a3, b3))).toBe('  if (x) {\n    []\n  }');
  });

  it('finds forwards and backwards, case-insensitive, wrapping around', () => {
    const text = 'Serial.begin(); serial.print();';
    expect(find(text, 'serial', 0)).toBe(0);
    expect(find(text, 'serial', 1)).toBe(16);
    expect(find(text, 'serial', 17)).toBe(0);
    expect(find(text, 'serial', 16, true)).toBe(0);
    expect(find(text, 'serial', 0, true)).toBe(16);
    expect(find(text, 'nope', 0)).toBe(-1);
    expect(lineOf('a\nb\nc', 4)).toBe(3);
  });

  it('in Python, Enter indents four spaces after a block opener and Tab uses four spaces (BT63)', () => {
    const [text, a, b] = sel('while True:[]');
    expect(apply(text, newline(text, a, b, true))).toBe('while True:\n    []');
    const [t2, a2, b2] = sel('    x = 1[]');
    expect(apply(t2, newline(t2, a2, b2, true))).toBe('    x = 1\n    []');
    const [t3, a3, b3] = sel('# note:[]');
    expect(apply(t3, newline(t3, a3, b3, true))).toBe('# note:\n[]');
    const [t4, a4, b4] = sel('[a\nb]');
    expect(apply(t4, indent(t4, a4, b4, false, PY_INDENT))).toBe('    [a\n    b]');
    const [t5, a5, b5] = sel('        x[]');
    expect(apply(t5, indent(t5, a5, b5, true, PY_INDENT))).toBe('    x[]');
  });
});

