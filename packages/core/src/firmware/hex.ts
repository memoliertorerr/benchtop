/**
 * Intel HEX parser for firmware images (`sketch.ino.hex`). The text is untrusted: every record
 * is checked (start code, hex digits, byte count, checksum, address range) and errors name the
 * 1-based line.
 *
 * Record types: 00 data, 01 end of file, 02 extended segment address (base = value × 16),
 * 03 start segment address (CS:IP, recorded as CS × 16 + IP), 04 extended linear address
 * (base = value × 65536), 05 start linear address (recorded).
 */

/** A malformed HEX file; `line` is 1-based. */
export class HexError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'HexError';
    this.line = line;
  }
}

export interface HexImage {
  /** Dense from address 0 to the highest used address; unused bytes are 0xFF (erased flash). */
  bytes: Uint8Array;
  /** Address ranges the file wrote, merged and sorted: [start, end). */
  used: { start: number; end: number }[];
  /** From a type 03 or 05 record, when present. */
  startAddress?: number;
}

/** Longest legal record: ':' + count + address + type + 255 data bytes + checksum. */
const MAX_RECORD_CHARS = 1 + 2 * (1 + 2 + 1 + 255 + 1);

export function parseIntelHex(text: string, opts: { maxBytes: number }): HexImage {
  const { maxBytes } = opts;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 0x1000_0000) {
    throw new RangeError(`maxBytes must be an integer in 1..2^28, got ${maxBytes}`);
  }
  const image = new Uint8Array(maxBytes).fill(0xff);
  const ranges: { start: number; end: number }[] = [];
  const record = new Uint8Array(MAX_RECORD_CHARS >> 1);
  let base = 0;
  let high = 0;
  let eof = false;
  let startAddress: number | undefined;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i].trim();
    if (line === '') continue;
    if (eof) throw new HexError(n, 'data after the end-of-file record');
    if (line[0] !== ':') throw new HexError(n, 'record does not start with ":"');
    if (line.length < 11 || line.length > MAX_RECORD_CHARS || line.length % 2 === 0) {
      throw new HexError(n, `malformed record (${line.length} characters)`);
    }
    const size = (line.length - 1) >> 1;
    let sum = 0;
    for (let k = 0; k < size; k++) {
      const hi = hexDigit(line.charCodeAt(1 + 2 * k));
      const lo = hexDigit(line.charCodeAt(2 + 2 * k));
      if (hi < 0 || lo < 0) throw new HexError(n, `invalid hex digit near column ${2 + 2 * k}`);
      record[k] = (hi << 4) | lo;
      sum += record[k];
    }
    const count = record[0];
    if (size !== count + 5) throw new HexError(n, `byte count ${count} does not match the record length`);
    if ((sum & 0xff) !== 0) throw new HexError(n, 'bad checksum');
    const offset = (record[1] << 8) | record[2];
    const type = record[3];
    switch (type) {
      case 0x00: {
        const start = base + offset;
        const end = start + count;
        if (end > maxBytes) {
          throw new HexError(n, `data at 0x${start.toString(16)}..0x${end.toString(16)} is beyond ${maxBytes} bytes`);
        }
        image.set(record.subarray(4, 4 + count), start);
        if (count > 0) ranges.push({ start, end });
        if (end > high) high = end;
        break;
      }
      case 0x01:
        if (count !== 0) throw new HexError(n, 'end-of-file record carries data');
        eof = true;
        break;
      case 0x02:
        if (count !== 2) throw new HexError(n, 'extended segment address record needs 2 bytes');
        base = ((record[4] << 8) | record[5]) * 16;
        break;
      case 0x03:
        if (count !== 4) throw new HexError(n, 'start segment address record needs 4 bytes');
        startAddress = ((record[4] << 8) | record[5]) * 16 + ((record[6] << 8) | record[7]);
        break;
      case 0x04:
        if (count !== 2) throw new HexError(n, 'extended linear address record needs 2 bytes');
        base = ((record[4] << 8) | record[5]) * 0x10000;
        break;
      case 0x05:
        if (count !== 4) throw new HexError(n, 'start linear address record needs 4 bytes');
        startAddress = ((record[4] << 24) | (record[5] << 16) | (record[6] << 8) | record[7]) >>> 0;
        break;
      default:
        throw new HexError(n, `unknown record type 0x${type.toString(16).padStart(2, '0')}`);
    }
  }
  if (!eof) throw new HexError(lines.length, 'missing end-of-file record (:00000001FF)');

  ranges.sort((a, b) => a.start - b.start);
  const used: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = used[used.length - 1];
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else used.push({ start: range.start, end: range.end });
  }
  const result: HexImage = { bytes: image.slice(0, high), used };
  if (startAddress !== undefined) result.startAddress = startAddress;
  return result;
}

function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 65 && c <= 70) return c - 55; // A-F
  if (c >= 97 && c <= 102) return c - 87; // a-f
  return -1;
}
