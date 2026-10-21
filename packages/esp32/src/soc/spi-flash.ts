/**
 * SPI1 (0x3FF42000), the flash controller the ROM's esp_rom_spiflash_* and IDF's spi_flash_ll
 * (SDK/include/hal/esp32/include/hal/spi_flash_ll.h) drive; SPI0 (0x3FF43000) is the cache's
 * controller and only holds configuration here. Writing SPI_CMD starts the command whose bit is
 * set; it completes at once, so CMD reads back 0 (spi_flash_ll_cmd_is_done) and EXT2's state
 * field reads 0 (spi_flash_ll_host_idle). Native commands (spi_reg.h bits): FLASH_READ (31,
 * ADDR = address | length << 24, data into W0–W15), WREN (30), WRDI (29), RDID (28, ID into W0),
 * RDSR (27, status into RD_STATUS), WRSR (26, from RD_STATUS), PP (25, ADDR = address |
 * length << 24, data from W0…), SE (24), BE (23), CE (22), DP/RES/HPM (21–19, no effect) and USR
 * (18): command phase (USER bit 31; USER2 COMMAND_VALUE 15:0, COMMAND_BITLEN 31:28 + 1), address
 * phase (USER bit 30; USER1 ADDR_BITLEN 31:26 + 1; ADDR left-aligned, so the 24-bit flash
 * address is ADDR >> 8 — spi_flash_ll_set_usr_address — and for a 32-bit phase the low byte is
 * the read-mode byte), dummy cycles (ignored), MOSI (USER bit 27, MOSI_DLEN + 1 bits from W0…,
 * low byte first) and MISO (USER bit 28, MISO_DLEN + 1 bits into W0…).
 */

import type { FlashChip } from './flash.ts';
import { RegisterFile } from './periph.ts';

export const SPI1_BASE = 0x3ff42000;
export const SPI0_BASE = 0x3ff43000;
const CMD = 0x00;
const ADDR = 0x04;
const RD_STATUS = 0x10;
const USER = 0x1c;
const USER1 = 0x20;
const USER2 = 0x24;
const MOSI_DLEN = 0x28;
const MISO_DLEN = 0x2c;
const W0 = 0x80;
const EXT2 = 0xf8;
const BIT = {
  READ: 1 << 31,
  WREN: 1 << 30,
  WRDI: 1 << 29,
  RDID: 1 << 28,
  RDSR: 1 << 27,
  WRSR: 1 << 26,
  PP: 1 << 25,
  SE: 1 << 24,
  BE: 1 << 23,
  CE: 1 << 22,
  USR: 1 << 18,
} as const;

export class SpiFlashController extends RegisterFile {
  private readonly flash: FlashChip;
  private readonly buffer = new Uint8Array(64);
  private readonly out = new Uint8Array(64);
  /** Commands run (for reports). */
  commands = 0;

  constructor(flash: FlashChip) {
    super(SPI1_BASE);
    this.flash = flash;
  }

  implements(): boolean {
    return true;
  }

  override read32(offset: number): number {
    if (offset === CMD || offset === EXT2) return 0;
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    if (offset !== CMD) {
      super.write32(offset, value);
      return;
    }
    this.commands++;
    const v = value >>> 0;
    const addr = this.regs[ADDR >>> 2];
    if ((v & BIT.READ) !== 0) {
      const length = Math.min(addr >>> 24 || 32, 64);
      this.flash.read(addr & 0xffffff, this.out, length);
      this.storeWords(this.out, length);
    } else if ((v & BIT.WREN) !== 0) this.flash.writeEnable(true);
    else if ((v & BIT.WRDI) !== 0) this.flash.writeEnable(false);
    else if ((v & BIT.RDID) !== 0) {
      this.out.fill(0, 0, 4);
      this.flash.transaction(0x9f, 0, this.buffer, 0, this.out, 3);
      this.storeWords(this.out, 4);
    } else if ((v & BIT.RDSR) !== 0) this.regs[RD_STATUS >>> 2] = this.flash.status;
    else if ((v & BIT.WRSR) !== 0) this.flash.writeStatus(this.regs[RD_STATUS >>> 2], 16);
    else if ((v & BIT.PP) !== 0) {
      const length = Math.min(addr >>> 24, 64);
      this.loadWords(this.buffer, length);
      this.flash.program(addr & 0xffffff, this.buffer, length);
    } else if ((v & BIT.SE) !== 0) this.flash.erase(addr & 0xffffff, 0x1000);
    else if ((v & BIT.BE) !== 0) this.flash.erase(addr & 0xffffff, 0x10000);
    else if ((v & BIT.CE) !== 0) this.flash.erase(0, this.flash.size);
    else if ((v & BIT.USR) !== 0) this.user();
  }

  /** A USR transaction (see the header). */
  private user(): void {
    const user = this.regs[USER >>> 2];
    const command = (user & (1 << 31)) !== 0 ? this.regs[USER2 >>> 2] & 0xff : -1;
    const addrBits = (user & (1 << 30)) !== 0 ? ((this.regs[USER1 >>> 2] >>> 26) & 0x3f) + 1 : 0;
    const address = addrBits >= 24 ? this.regs[ADDR >>> 2] >>> 8 : addrBits > 0 ? this.regs[ADDR >>> 2] >>> (32 - addrBits) : 0;
    const mosiLength = (user & (1 << 27)) !== 0 ? Math.min(((this.regs[MOSI_DLEN >>> 2] & 0xffffff) + 8) >>> 3, 64) : 0;
    const misoLength = (user & (1 << 28)) !== 0 ? Math.min(((this.regs[MISO_DLEN >>> 2] & 0xffffff) + 8) >>> 3, 64) : 0;
    this.loadWords(this.buffer, mosiLength);
    if (command >= 0) this.flash.transaction(command, address, this.buffer, mosiLength, this.out, misoLength);
    else this.out.fill(0xff, 0, misoLength);
    if (misoLength > 0) this.storeWords(this.out, misoLength);
  }

  private loadWords(into: Uint8Array, length: number): void {
    for (let i = 0; i < length; i++) into[i] = (this.regs[(W0 >>> 2) + (i >>> 2)] >>> ((i & 3) * 8)) & 0xff;
  }

  private storeWords(from: Uint8Array, length: number): void {
    for (let w = 0; w < (length + 3) >>> 2; w++) {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        const i = w * 4 + b;
        if (i < length) v |= from[i] << (8 * b);
      }
      this.regs[(W0 >>> 2) + w] = v >>> 0;
    }
  }
}

/** SPI0: cache-side configuration only (storage, not logged). */
export class SpiCacheController extends RegisterFile {
  constructor() {
    super(SPI0_BASE);
  }

  implements(): boolean {
    return true;
  }

  override read32(offset: number): number {
    if (offset === CMD || offset === EXT2) return 0;
    return super.read32(offset);
  }
}
