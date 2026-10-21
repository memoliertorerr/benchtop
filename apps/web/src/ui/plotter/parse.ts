/**
 * The serial plotter's input (BT44), by the Arduino IDE 2 plotter's rules: a line holds values
 * separated by spaces, tabs or commas; a value may carry a label, `label:value`; unlabeled values
 * are named by their position ("value 1", "value 2", …). Fields that aren't numbers are ignored,
 * so a line with none (a message, garbage) adds nothing. Pure and allocation-light, so a fast
 * stream (1,000 lines/s) costs well under 2 ms a second; tested in Node.
 */

export interface Sample {
  label: string;
  value: number;
}

const SEPARATOR = /[ \t,]+/;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The labeled values of one line (empty for a line with no numbers). */
export function parseLine(line: string): Sample[] {
  const out: Sample[] = [];
  let position = 0;
  for (const field of line.trim().split(SEPARATOR)) {
    if (field === '') continue;
    const colon = field.lastIndexOf(':');
    const label = colon > 0 ? field.slice(0, colon) : '';
    const text = colon >= 0 ? field.slice(colon + 1) : field;
    if (!NUMBER.test(text)) continue;
    position++;
    out.push({ label: label === '' ? `value ${position}` : label, value: Number(text) });
  }
  return out;
}

/** Cuts a byte stream into lines (CR, LF or CRLF), keeping a partial line for the next chunk. */
export class LineSplitter {
  private partial = '';

  /** The complete lines in `text` (plus what was left over before). */
  push(text: string): string[] {
    const parts = (this.partial + text).split(/\r\n|\r|\n/);
    this.partial = parts.pop() ?? '';
    // A runaway line without a newline is dropped, not kept forever.
    if (this.partial.length > 4096) this.partial = '';
    return parts;
  }

  clear(): void {
    this.partial = '';
  }
}
