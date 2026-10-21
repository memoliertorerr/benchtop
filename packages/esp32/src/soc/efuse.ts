/**
 * eFuse controller (0x3FF5A000; efuse_reg.h) with Benchtop's fuse values — a plain ESP32-D0WD
 * rev 1 with nothing burned but the MAC: BLK0_RDATA1/2 hold MAC 24:0A:C4:00:00:01 and its CRC8
 * (ESP-IDF's MAC_FACTORY field: RDATA2[15:8] is the first byte, …, RDATA1[7:0] the last;
 * RDATA2[23:16] the CRC); RDATA3 bit 15 CHIP_VER_REV1 = 1, RDATA5 bit 20 CHIP_VER_REV2 = 0 (with
 * APB_CTRL_DATE bit 31 = 0 that's rev 1 — not ECO3, so IDF's ECO3 cache-lock workaround stays
 * off); package 0, APP_CPU enabled, coding scheme 0, FLASH_CRYPT_CNT 0, BLK1–3 zero. The read
 * registers ignore writes; EFUSE_CMD reads 0 (every command completes at once). Burning isn't
 * modeled: PGM commands leave the fuses as they are.
 */

import { RegisterFile } from './periph.ts';

export const EFUSE_BASE = 0x3ff5a000;
export const EFUSE_MAC: readonly number[] = [0x24, 0x0a, 0xc4, 0x00, 0x00, 0x01];
const CMD = 0x104;
const READ_END = 0x098; // BLK0 RDATA … BLK3 RDATA, with the BLK0 WDATA in between

/** CRC-8 as esp_rom_efuse_mac_address_crc8 computes it (x^8 + x^5 + x^4 + 1, reflected, init 0). */
export function macCrc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
  }
  return crc;
}

export class Efuse extends RegisterFile {
  constructor() {
    super(EFUSE_BASE);
    const m = EFUSE_MAC;
    this.regs[1] = ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0; // BLK0_RDATA1
    this.regs[2] = (macCrc8(m) << 16) | (m[0] << 8) | m[1]; // BLK0_RDATA2
    this.regs[3] = 1 << 15; // BLK0_RDATA3: CHIP_VER_REV1
  }

  implements(offset: number): boolean {
    return offset < READ_END || offset === CMD;
  }

  /** Fuses are one-time programmable: a chip reset changes nothing. */
  override systemReset(_rtcDomain: boolean): void {}

  override read32(offset: number): number {
    return offset === CMD ? 0 : super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    if (offset < 0x01c || (offset >= 0x038 && offset < READ_END)) return; // read-only fuse data
    super.write32(offset, value);
  }
}
