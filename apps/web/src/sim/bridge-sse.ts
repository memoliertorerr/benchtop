/**
 * Server-Sent Events parsing for the compile bridge's watch stream, and the reconnect backoff.
 * Pure (no fetch, no timers), so both are tested in Node. The stream arrives in arbitrary
 * chunks: a field, a line ending (even CR LF) or an event can be split across them.
 */

export interface SseEvent {
  /** The `event:` field, `message` when absent. */
  event: string;
  /** The `data:` lines, joined with LF. */
  data: string;
}

/** Event streams longer than this without a blank line are dropped (a broken server). */
const MAX_PENDING = 32 * 1024 * 1024;

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  /** A chunk ended in CR: an LF starting the next chunk belongs to that line ending. */
  private skipLf = false;

  /** Feeds decoded text; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    let text = chunk;
    if (this.skipLf && text.startsWith('\n')) text = text.slice(1);
    this.skipLf = false;
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line(this.buffer.slice(start, i), events);
      if (c === 13) {
        if (i + 1 === this.buffer.length) this.skipLf = true;
        else if (this.buffer.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_PENDING) this.reset();
    return events;
  }

  /** Forgets any partial event (after a reconnect). */
  reset(): void {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.skipLf = false;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === '') {
      if (this.data.length > 0) events.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    // id and retry are not used: the client reconnects on its own schedule.
  }
}

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/** Reconnect delays: 1 s, 2 s, 4 s … capped at 30 s; `reset()` after a good connection. */
export class Backoff {
  private attempt = 0;

  next(): number {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    if (delay < BACKOFF_MAX_MS) this.attempt++;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
