/**
 * A board's serial output as lines: bytes arrive in arbitrary chunks (a line, a multi-byte UTF-8
 * character or a CR LF can be split across them), lines end at LF (a trailing CR is dropped),
 * and each line carries the simulated time its first byte arrived. The newest ~1 MB is kept;
 * older lines fall off the front. Pure (TextDecoder streams the UTF-8), tested in Node.
 */

export interface SerialLine {
  text: string;
  /** Simulated time (ns) of the line's first byte. */
  t: number;
  /** False for the last line while it is still being written. */
  complete: boolean;
}

/** Default capacity: 1 MB of text. */
export const SERIAL_CAPACITY = 1 << 20;
/** A line longer than this without a newline is cut, so a stream without LF still scrolls. */
export const MAX_LINE = 16 * 1024;

export class SerialBuffer {
  readonly capacity: number;
  /** Lines dropped from the front since the start (index of `lines[0]`). */
  dropped = 0;
  /** Increments on every change, for views to notice. */
  version = 0;
  private readonly kept: SerialLine[] = [];
  private size = 0;
  private decoder = new TextDecoder('utf-8');

  constructor(capacity = SERIAL_CAPACITY) {
    this.capacity = capacity;
  }

  get lines(): readonly SerialLine[] {
    return this.kept;
  }

  append(bytes: Uint8Array, t: number): void {
    if (bytes.length === 0) return;
    const text = this.decoder.decode(bytes, { stream: true });
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i < text.length && text.charCodeAt(i) !== 10) continue;
      this.write(text.slice(start, i), t);
      if (i < text.length) this.endLine();
      start = i + 1;
    }
    this.trim();
    this.version++;
  }

  /** A line of its own, such as "— reloaded —": ends any partial line first. */
  mark(text: string, t: number): void {
    const last = this.kept[this.kept.length - 1];
    if (last !== undefined) last.complete = true;
    this.decoder = new TextDecoder('utf-8'); // a character split across the old output is gone
    this.kept.push({ text, t, complete: true });
    this.size += text.length;
    this.trim();
    this.version++;
  }

  clear(): void {
    this.dropped += this.kept.length;
    this.kept.length = 0;
    this.size = 0;
    this.decoder = new TextDecoder('utf-8');
    this.version++;
  }

  private open(t: number): SerialLine {
    const last = this.kept[this.kept.length - 1];
    if (last !== undefined && !last.complete) return last;
    const line: SerialLine = { text: '', t, complete: false };
    this.kept.push(line);
    return line;
  }

  private write(chunk: string, t: number): void {
    if (chunk.length === 0) return;
    let rest = chunk;
    while (rest.length > 0) {
      const line = this.open(t);
      const room = MAX_LINE - line.text.length;
      const piece = rest.slice(0, room);
      line.text += piece;
      this.size += piece.length;
      rest = rest.slice(piece.length);
      if (line.text.length >= MAX_LINE) line.complete = true;
    }
  }

  private endLine(): void {
    const last = this.kept[this.kept.length - 1];
    if (last === undefined || last.complete) {
      // An empty line (LF right after LF): still a line.
      this.kept.push({ text: '', t: last?.t ?? 0, complete: true });
      return;
    }
    if (last.text.endsWith('\r')) {
      last.text = last.text.slice(0, -1);
      this.size--;
    }
    last.complete = true;
  }

  private trim(): void {
    while (this.size > this.capacity && this.kept.length > 1) {
      const gone = this.kept.shift() as SerialLine;
      this.size -= gone.text.length;
      this.dropped++;
    }
  }
}
