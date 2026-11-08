/**
 * What the bench's USB host received (BT138), as a computer would show it: the text a keyboard
 * typed and a log of the other things devices sent (mouse moves and clicks, media keys, MIDI
 * messages). Chip-neutral, DOM-free; usb-host.ts owns one, usb-hid.ts and usb-midi.ts write it.
 *
 * Keeps the last `TYPED_LIMIT` characters and `EVENT_LIMIT` events. An event can carry a merge
 * key: a new event with the key of the newest one replaces its text (a mouse moving, a pot's
 * control change sweeping), so a stream of small changes stays one line.
 */

export const TYPED_LIMIT = 4096;
export const EVENT_LIMIT = 256;

export interface UsbEvent {
  /** When, in the clock's seconds (the MCU's). */
  at: number;
  text: string;
  /** Merge key ('' for none). */
  key: string;
}

export class UsbLog {
  /** The keyboard's text (the last TYPED_LIMIT characters). */
  typed = '';
  /** The last EVENT_LIMIT events, oldest first. */
  readonly events: UsbEvent[] = [];
  /** Events dropped from the front. */
  dropped = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Text a keyboard typed. */
  type(text: string): void {
    const typed = this.typed + text;
    this.typed = typed.length > TYPED_LIMIT ? typed.slice(typed.length - TYPED_LIMIT) : typed;
  }

  /** Backspace: the typed text loses its last character, as in an editor. */
  backspace(): void {
    if (this.typed.length > 0) this.typed = this.typed.slice(0, -1);
  }

  /** The newest event's merge key ('' when none). */
  get lastKey(): string {
    return this.events.length === 0 ? '' : this.events[this.events.length - 1].key;
  }

  /** Logs `text`; with the newest event's (non-empty) `key`, replaces that event instead. */
  event(text: string, key = ''): void {
    const last = this.events.length === 0 ? undefined : this.events[this.events.length - 1];
    if (key !== '' && last !== undefined && last.key === key) {
      last.text = text;
      last.at = this.now();
      return;
    }
    if (this.events.length === EVENT_LIMIT) {
      this.events.shift();
      this.dropped++;
    }
    this.events.push({ at: this.now(), text, key });
  }
}
