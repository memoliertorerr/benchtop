/**
 * GDB Remote Serial Protocol framing (DOM-free). A streaming decoder fed arbitrary chunks:
 * '+'/'-' acks, `$<data>#<2 hex>` packets (checksum = sum of the data bytes as sent, mod 256),
 * the 0x03 interrupt byte between packets, and '}' escapes (the next byte XOR 0x20) in packet
 * data. Packet data is a binary string (one char per byte). The encoder escapes '$', '#', '}'
 * and '*'.
 */

export type RspEvent =
  | { type: 'ack' }
  | { type: 'nack' }
  | { type: 'interrupt' }
  | { type: 'packet'; data: string }
  /** A packet whose checksum didn't match (the receiver answers '-'). */
  | { type: 'bad' };

/** Longest packet data accepted; longer ones are dropped as bad (PacketSize is 0x1000). */
export const MAX_PACKET = 0x4000;

const HEX = '0123456789abcdef';

export function checksum(data: string): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum = (sum + data.charCodeAt(i)) & 0xff;
  return sum;
}

/** `$<escaped data>#<checksum>`. */
export function encodePacket(data: string): string {
  let escaped = '';
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    escaped += c === 0x23 || c === 0x24 || c === 0x7d || c === 0x2a ? `}${String.fromCharCode(c ^ 0x20)}` : data[i];
  }
  const sum = checksum(escaped);
  return `$${escaped}#${HEX[sum >> 4]}${HEX[sum & 15]}`;
}

const STATE = { idle: 0, data: 1, escape: 2, sum1: 3, sum2: 4 } as const;

export class RspDecoder {
  private state: number = STATE.idle;
  private data: string[] = [];
  private sum = 0;
  private expected = 0;
  private overflow = false;

  /** The events in `chunk`, in order (a packet may span several chunks). */
  feed(chunk: Uint8Array): RspEvent[] {
    const events: RspEvent[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      switch (this.state) {
        case STATE.idle:
          if (b === 0x2b) events.push({ type: 'ack' });
          else if (b === 0x2d) events.push({ type: 'nack' });
          else if (b === 0x03) events.push({ type: 'interrupt' });
          else if (b === 0x24) {
            this.state = STATE.data;
            this.data = [];
            this.sum = 0;
            this.overflow = false;
          }
          break; // anything else between packets is noise
        case STATE.data:
        case STATE.escape:
          if (b === 0x23 && this.state === STATE.data) {
            this.state = STATE.sum1;
            break;
          }
          this.sum = (this.sum + b) & 0xff;
          if (this.state === STATE.escape) {
            this.push(b ^ 0x20);
            this.state = STATE.data;
          } else if (b === 0x7d) {
            this.state = STATE.escape;
          } else {
            this.push(b);
          }
          break;
        case STATE.sum1:
          this.expected = hexValue(b) << 4;
          this.state = hexValue(b) < 0 ? STATE.idle : STATE.sum2;
          if (this.state === STATE.idle) events.push({ type: 'bad' });
          break;
        case STATE.sum2: {
          const low = hexValue(b);
          this.state = STATE.idle;
          if (low < 0 || this.overflow || (this.expected | low) !== this.sum) events.push({ type: 'bad' });
          else events.push({ type: 'packet', data: this.data.join('') });
          this.data = [];
          break;
        }
      }
    }
    return events;
  }

  private push(byte: number): void {
    if (this.data.length >= MAX_PACKET) this.overflow = true;
    else this.data.push(String.fromCharCode(byte));
  }
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  return -1;
}

/** Bytes → lowercase hex. */
export function toHex(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[(bytes[i] >> 4) & 15] + HEX[bytes[i] & 15];
  return out;
}

/** Hex → bytes, or undefined when it isn't an even run of hex digits. */
export function fromHex(text: string): Uint8Array | undefined {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
