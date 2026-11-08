/**
 * The ESP32-S3's PSRAM (BT130): the chip on SPI0/1's second chip select, answering whichever
 * protocol the build's PSRAM driver speaks over SPI1 (spi-mem.ts's `cs1`):
 *
 * - quad (Arduino's "QSPI PSRAM", IDF 4.4's esp32s3 spiram_psram.c): @benchtop/esp32's QuadPsram
 *   (BT133 shares it with the ESP32) — 0x9F's ID says 16 Mbit (EID 0x00), so the chip is 2 MB, as
 *   on the WROOM-1 N8R2; reset, QPI entry and exit, reads and writes as there.
 * - octal (Arduino's "OPI PSRAM", opi_psram.c, OPI DTR with 16-bit commands): 0x4040 reads mode
 *   registers from the address given (MR0 latency/drive, MR1 vendor 0x0D — AP Memory —, MR2 density
 *   0x3 (64 Mbit) with Good-Die set, MR3, MR4, MR8), 0xC0C0 writes them; 0x0000 reads and 0x8080
 *   writes data. 8 MB, as on the N8R8.
 *
 * BT135: the board's module can narrow it — `protocols` 'quad' (an N8R2's chip) or 'octal' (an
 * N8R8's) leaves the other protocol's commands unanswered, `present` false (an N8) all of them.
 *
 * The cache reaches the data through the MMU's SPIRAM pages (bus.ts), not through these commands.
 * The bytes are allocated on first use, so an S3 that never touches PSRAM costs nothing; `size`
 * is what the protocol in use says (a quad build maps only its 2 MB).
 */

import { QuadPsram } from '@benchtop/esp32';
import type { SpiMemChip } from '@benchtop/esp32c3';

export const S3_PSRAM_BYTES = 8 * 1024 * 1024;
export const S3_PSRAM_QUAD_BYTES = 2 * 1024 * 1024;
/** The quad ID's bytes: MFID, KGD, EID (density bits 7:5 = 0: 16 Mbit). */
export const S3_PSRAM_QUAD_ID = [0x0d, 0x5d, 0x00] as const;
/** Mode registers at reset: MR1 vendor 0x0D; MR2 Good-Die (7), density 0x3 (64 Mbit). */
const MODE_REGISTER_RESET = [0x09, 0x0d, 0x83, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] as const;
/** BT135: the protocols the chip answers — both (the build decides), or one module's. */
export type S3PsramProtocols = 'both' | 'quad' | 'octal';
const isOctal = (command: number): boolean => command === 0x4040 || command === 0xc0c0 || command === 0xffff || command === 0x0000 || command === 0x8080;

export class S3Psram extends QuadPsram implements SpiMemChip {
  /** OPI mode registers MR0–MR8. */
  readonly modeRegisters = new Uint8Array(9);
  /** The protocol last heard: 'quad' (2 MB) or 'octal' (8 MB); null until the driver asks. */
  mode: 'quad' | 'octal' | null = null;
  /** BT135: which protocols this module's chip speaks. */
  protocols: S3PsramProtocols = 'both';

  constructor() {
    super(S3_PSRAM_BYTES, S3_PSRAM_QUAD_ID);
    this.modeRegisters.set(MODE_REGISTER_RESET);
  }

  /** Bytes the protocol in use addresses: 2 MB quad, 8 MB octal (and before either). */
  override get size(): number {
    if (!this.present) return 0;
    return this.mode === 'quad' || this.protocols === 'quad' ? S3_PSRAM_QUAD_BYTES : S3_PSRAM_BYTES;
  }

  override command(command: number, address: number, mosi: Uint8Array, miso: Uint8Array): void {
    const octal = isOctal(command);
    if (!this.present || (octal && this.protocols === 'quad') || (!octal && this.protocols === 'octal')) {
      miso.fill(0);
      return;
    }
    switch (command) {
      case 0x9f: // quad: read ID
        this.mode = 'quad';
        super.command(command, address, mosi, miso);
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
      case 0x0000:
        this.read(address, miso);
        return;
      case 0x8080:
        this.write(address, mosi);
        return;
      default:
        super.command(command, address, mosi, miso);
    }
  }
}
