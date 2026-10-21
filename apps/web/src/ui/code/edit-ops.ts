/**
 * The code editor's text operations (BT42), pure so they're tested in Node: each returns the
 * range to replace, the text to put there and the selection after — the editor applies it as
 * one insertText, which keeps the browser's own undo history.
 */

export const INDENT = '  ';

export interface Edit {
  /** Replace text[from, to) with `insert`, then select [selStart, selEnd). */
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

const lineStartOf = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;

/**
 * Tab / Shift-Tab. A caret with Tab inserts an indent; a selection (or Shift-Tab) indents or
 * unindents every line it touches by one level, keeping those lines selected.
 */
export function indent(text: string, selStart: number, selEnd: number, out: boolean): Edit {
  if (selStart === selEnd && !out) return { from: selStart, to: selEnd, insert: INDENT, selStart: selStart + INDENT.length, selEnd: selStart + INDENT.length };
  const from = lineStartOf(text, selStart);
  // A selection ending at a line's start doesn't take that line.
  const lastPos = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  let to = text.indexOf('\n', lastPos);
  if (to < 0) to = text.length;
  const lines = text.slice(from, to).split('\n');
  let firstDelta = 0;
  let total = 0;
  const changed = lines.map((line, i) => {
    let next: string;
    if (out) {
      const spaces = line.startsWith(INDENT) ? INDENT.length : line.startsWith(' ') || line.startsWith('\t') ? 1 : 0;
      next = line.slice(spaces);
    } else {
      next = line.length === 0 ? line : INDENT + line;
    }
    const delta = next.length - line.length;
    if (i === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  const insert = changed.join('\n');
  const start = Math.max(from, selStart + firstDelta);
  return { from, to, insert, selStart: selStart === selEnd ? start : start, selEnd: selStart === selEnd ? start : Math.max(start, selEnd + total) };
}

/**
 * Enter: a newline with the current line's indentation, one level more after an opening `{`
 * (and, when the caret sits right before its `}`, that brace on its own line below).
 */
export function newline(text: string, selStart: number, selEnd: number): Edit {
  const start = lineStartOf(text, selStart);
  const lead = /^[ \t]*/.exec(text.slice(start, selStart))?.[0] ?? '';
  const before = text.slice(start, selStart).trimEnd();
  const opens = before.endsWith('{');
  if (opens && text[selEnd] === '}') {
    const insert = `\n${lead}${INDENT}\n${lead}`;
    const caret = selStart + 1 + lead.length + INDENT.length;
    return { from: selStart, to: selEnd, insert, selStart: caret, selEnd: caret };
  }
  const insert = `\n${lead}${opens ? INDENT : ''}`;
  return { from: selStart, to: selEnd, insert, selStart: selStart + insert.length, selEnd: selStart + insert.length };
}

/** The next (or previous) match of `query` from `from`, case-insensitive, wrapping; −1 if none. */
export function find(text: string, query: string, from: number, backwards = false): number {
  if (query === '') return -1;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (backwards) {
    // lastIndexOf clamps a negative start to 0 and would find a match there: wrap instead.
    const at = from > 0 ? hay.lastIndexOf(needle, from - 1) : -1;
    return at >= 0 ? at : hay.lastIndexOf(needle);
  }
  const at = hay.indexOf(needle, from);
  return at >= 0 ? at : hay.indexOf(needle);
}

/** 1-based line number of a position. */
export function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) line++;
  return line;
}
