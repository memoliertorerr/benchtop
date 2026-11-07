/**
 * The ESP32-S3's PSRAM (BT130): the chip on SPI0/1's second chip select, answering whichever
 * protocol the build's PSRAM driver speaks over SPI1 (spi-mem.ts's `cs1`):
 *
 * - quad (Arduino's "QSPI PSRAM", IDF 4.4's esp32s3 spiram_psram.c): 0x9F reads a 24-bit ID — MFID
 *   0x0D, KGD 0x5D, EID whose bits 7:5 give the density (0: 16 Mbit) — so the chip is 2 MB, as on
 *   the WROOM-1 N8R2; 0x66/0x99 reset it, 0x35/0xF5 enter and leave QPI; 0x03/0x0B/0xEB read and
 *   0x02/0x38 write data.
 * - octal (Arduino's "OPI PSRAM", opi_psram.c, OPI DTR with 16-bit commands): 0x4040 reads mode
 *   registers from the address given (MR0 latency/drive, MR1 vendor 0x0D — AP Memory —, MR2 density
 *   0x3 (64 Mbit) with Good-Die set, MR3, MR4, MR8), 0xC0C0 writes them; 0x0000 reads and 0x8080
 *   writes data. 8 MB, as on the N8R8.
 *
 * The cache reaches the data through the MMU's SPIRAM pages (bus.ts), not through these commands.
 * The bytes are allocated on first use, so an S3 that never touches PSRAM costs nothing; `size`
 * is what the protocol in use says (a quad build maps only its 2 MB).
 */

import type { SpiMemChip } from '@benchtop/esp32c3';

export const S3_PSRAM_BYTES = 8 * 1024 * 1024;
export const S3_PSRAM_QUAD_BYTES = 2 * 1024 * 1024;
/** The quad ID's bytes: MFID, KGD, EID (density bits 7:5 = 0: 16 Mbit). */
export const S3_PSRAM_QUAD_ID = [0x0d, 0x5d, 0x00] as const;
/** Mode registers at reset: MR1 vendor 0x0D; MR2 Good-Die (7), density 0x3 (64 Mbit). */
const MODE_REGISTER_RESET = [0x09, 0x0d, 0x83, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] as const;

export class S3Psram implements SpiMemChip {
  private bytes: Uint8Array | null = null;
  private words: Uint32Array | null = null;
  /** OPI mode registers MR0–MR8. */
  readonly modeRegisters = new Uint8Array(9);
  /** QPI entered (quad 0x35, left by 0xF5). */
  qpi = false;
  /** The protocol last heard: 'quad' (2 MB) or 'octal' (8 MB); null until the driver asks. */
  mode: 'quad' | 'octal' | null = null;

  constructor() {
    this.modeRegisters.set(MODE_REGISTER_RESET);
  }

  /** Whether anything has touched the bytes yet (a build without PSRAM never does). */
  get allocated(): boolean {
    return this.bytes !== null;
  }

  /** The chip's bytes (allocated on first use). */
  get data(): Uint8Array {
    if (this.bytes === null) {
      this.bytes = new Uint8Array(S3_PSRAM_BYTES);
      this.words = new Uint32Array(this.bytes.buffer);
    }
    return this.bytes;
  }

  /** The same bytes as words, for the bus's aligned accesses. */
  get dataWords(): Uint32Array {
    if (this.words === null) void this.data;
    return this.words as Uint32Array;
  }

  /** Bytes the protocol in use addresses: 2 MB quad, 8 MB octal (and before either). */
  get size(): number {
    return this.mode === 'quad' ? S3_PSRAM_QUAD_BYTES : S3_PSRAM_BYTES;
  }

  command(command: number, address: number, mosi: Uint8Array, miso: Uint8Array): void {
    switch (command) {
      case 0x9f: // quad: read ID
        this.mode = 'quad';
        for (let i = 0; i < miso.length; i++) miso[i] = S3_PSRAM_QUAD_ID[i] ?? 0;
        return;
      case 0x66: // reset enable
        return;
      case 0x99: // reset
        this.qpi = false;
        return;
      case 0x35:
        this.qpi = true;
        return;
      case 0xf5:
        this.qpi = false;
        return;
      case 0x4040: // octal: mode register read
        this.mode = 'octal';
        for (let i = 0; i < miso.length; i++) miso[i] = this.modeRegisters[(address + i) & 0xff] ?? 0;
        return;
      case 0xc0c0: // octal: mode register write
        this.mode = 'octal';
        for (let i = 0; i < mosi.length; i++) {
          const r = (address + i) & 0xff;
          if (r < this.modeRegisters.length && r !== 1 && r !== 2) this.modeRegisters[r] = mosi[i];
        }
        return;
      case 0xffff: // octal: global reset
        this.modeRegisters.set(MODE_REGISTER_RESET);
        return;
      case 0x03:
      case 0x0b:
      case 0xeb:
      case 0x0000: {
        const data = this.data;
        const mask = this.size - 1;
        for (let i = 0; i < miso.length; i++) miso[i] = data[(address + i) & mask];
        return;
      }
      case 0x02:
      case 0x38:
      case 0x8080: {
        const data = this.data;
        const mask = this.size - 1;
        for (let i = 0; i < mosi.length; i++) data[(address + i) & mask] = mosi[i];
        return;
      }
      default:
    }
  }
}
