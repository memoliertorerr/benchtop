/**
 * A small ustar (POSIX tar) reader for the ROM tarball: 512-byte headers whose checksum is
 * validated, octal sizes kept inside the archive, GNU long names ('L') and pax headers ('x',
 * 'g') understood, everything else listed. DOM-free; the gunzip happens in the caller (node:zlib).
 */

export interface TarEntry {
  name: string;
  /** '0' file, '5' directory, … */
  type: string;
  data: Uint8Array;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

function text(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && bytes[i] !== 0; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function octal(bytes: Uint8Array, start: number, length: number, what: string): number {
  const field = text(bytes, start, length).trim();
  if (field === '') return 0;
  if (!/^[0-7]+$/.test(field)) throw new TarError(`bad octal ${what} "${field}"`);
  return Number.parseInt(field, 8);
}

/** Every entry in a tar archive. Throws TarError on a corrupt header or a size past the end. */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    const stored = octal(header, 148, 8, 'checksum');
    if (stored !== sum) throw new TarError(`header checksum at ${offset} is ${stored}, computed ${sum}`);
    const size = octal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    if (size > archive.length - dataStart) throw new TarError(`entry at ${offset} (${size} bytes) runs past the end of the archive`);
    const data = archive.subarray(dataStart, dataStart + size);
    const prefix = text(header, 345, 155);
    const name = longName ?? (prefix === '' ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
    longName = null;
    if (type === 'L') longName = text(data, 0, data.length);
    else if (type !== 'x' && type !== 'g') entries.push({ name, type, data });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
