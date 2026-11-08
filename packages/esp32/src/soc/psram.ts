/**
 * Quad SPI PSRAM (BT133; BT130's quad protocol, shared with @benchtop/esp32s3): the chip on the
 * flash bus's second chip select (CS1), as the ESP32's psram driver (IDF 4.4's esp32
 * spiram_psram.c) and the ESP32-S3's quad driver speak to it over SPI1's user commands — 0x9F reads
 * a 24-bit ID (MFID 0x0D, KGD 0x5D, EID whose bits 7:5 give the density: 0 16 Mbit, 1 32, 2 64),
 * 0x66/0x99 reset it, 0x35/0xF5 enter and leave QPI, 0x03/0x0B/0xEB read and 0x02/0x38 write data.
 * The caches reach the data through their MMUs (the buses), not through these commands.
 *
 * The bytes are allocated on first use, so a chip that never runs a PSRAM build costs nothing.
 * BT135: `present` false is a module without PSRAM (a WROOM-32): nothing answers on CS1.
 * The ESP32's is 8 MB, as on a WROVER-E module (its ESP-PSRAM64H): the ESP32 maps 4 MB of it at
 * 0x3F800000 (IDF's himem banks the rest).
 */

/** The ESP32's chip: 64 Mbit. */
export const ESP32_PSRAM_BYTES = 8 * 1024 * 1024;
/** The ESP32 chip's ID bytes: MFID, KGD, EID (density bits 7:5 = 2: 64 Mbit). */
export const ESP32_PSRAM_ID = [0x0d, 0x5d, 0x40] as const;

export class QuadPsram {
  /** Bytes the chip holds (what `data` allocates). */
  readonly capacity: number;
  private readonly id: readonly number[];
  private bytes: Uint8Array | null = null;
  private words: Uint32Array | null = null;
  /** QPI entered (0x35, left by 0xF5 or a reset). */
  qpi = false;
  /** BT135: the module has the chip; false, CS1 has nothing on it and reads 0. */
  present = true;
  /** BT136: a driver has read the chip's ID (0x9F) since power-on — a build that uses PSRAM. */
  identified = false;
  /** BT136: called when `identified` becomes true. */
  onIdentified: (() => void) | null = null;

  constructor(capacity: number, id: readonly number[]) {
    this.capacity = capacity;
    this.id = id;
  }

  /** Whether anything has touched the bytes since power-on (a build without PSRAM never does). */
  get allocated(): boolean {
    return this.bytes !== null;
  }

  /** The chip's bytes (allocated on first use). */
  get data(): Uint8Array {
    if (this.bytes === null) {
      this.bytes = new Uint8Array(this.capacity);
      this.words = new Uint32Array(this.bytes.buffer);
    }
    return this.bytes;
  }

  /** The same bytes as words, for the buses' aligned accesses. */
  get dataWords(): Uint32Array {
    if (this.words === null) void this.data;
    return this.words as Uint32Array;
  }

  /** Bytes the chip answers for (a power of two; 0 without the chip — the MMU maps nothing). */
  get size(): number {
    return this.present ? this.capacity : 0;
  }

  /** The supply goes (the ESP32's VDD_SDIO in deep sleep): the contents are lost. */
  powerOff(): void {
    this.bytes = null;
    this.words = null;
    this.qpi = false;
    this.identified = false;
  }

  /** One SPI transaction on CS1: `mosi` holds what the host sends, `miso` gets the reply. */
  command(command: number, address: number, mosi: Uint8Array, miso: Uint8Array): void {
    if (!this.present) {
      miso.fill(0);
      return;
    }
    switch (command) {
      case 0x9f: // read ID
        for (let i = 0; i < miso.length; i++) miso[i] = this.id[i] ?? 0;
        if (!this.identified) {
          this.identified = true;
          this.onIdentified?.();
        }
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
      case 0x03:
      case 0x0b:
      case 0xeb:
        this.read(address, miso);
        return;
      case 0x02:
      case 0x38:
        this.write(address, mosi);
        return;
      default:
    }
  }

  /** Data from `address` (wrapping at `size`) into `miso`. */
  protected read(address: number, miso: Uint8Array): void {
    const data = this.data;
    const mask = this.size - 1;
    for (let i = 0; i < miso.length; i++) miso[i] = data[(address + i) & mask];
  }

  /** `mosi` written at `address` (wrapping at `size`). */
  protected write(address: number, mosi: Uint8Array): void {
    const data = this.data;
    const mask = this.size - 1;
    for (let i = 0; i < mosi.length; i++) data[(address + i) & mask] = mosi[i];
  }
}
