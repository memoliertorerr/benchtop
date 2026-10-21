import { describe, expect, it } from 'vitest';
import { BareMachine, IRAM_BASE } from '../test-support/bare-machine.test-helper.ts';
import { cachedRom } from '../test-support/boot.test-helper.ts';
import { HALT } from '../xtensa/cpu.ts';
import { Efuse, EFUSE_MAC, macCrc8 } from '../soc/efuse.ts';

// BT32: the MAC CRC Benchtop's eFuse stores is what the ROM's own esp_rom_efuse_mac_address_crc8
// computes, run on our core (through romcall.S, as BT30's ROM libgcc tests do).

describe('eFuse MAC', () => {
  it('stores the CRC8 the ROM computes for the MAC', () => {
    const rom = cachedRom();
    const address = rom.symbols.get('esp_crc8') ?? rom.symbols.get('esp_rom_efuse_mac_address_crc8');
    if (address === undefined) throw new Error('no esp_crc8 in the ROM');
    const machine = BareMachine.load('romcall', { rom: true });
    const MAC_AT = 0x3ffb0900;
    EFUSE_MAC.forEach((b, i) => machine.bus.write8(MAC_AT + i, b));
    [MAC_AT, 6, 0, 0, address].forEach((v, i) => machine.bus.write32(0x3ffb0800 + i * 4, v));
    machine.bus.write32(0x3ffb0800 + 28, 0); // nesting depth
    machine.core.pc = IRAM_BASE;
    machine.core.run(100_000);
    expect(machine.core.halt).toBe(HALT.BREAK);
    const romCrc = machine.read32(0x3ffb0800 + 20) & 0xff;
    const efuse = new Efuse();
    expect((efuse.read32(0x008) >>> 16) & 0xff).toBe(romCrc);
    expect(macCrc8(EFUSE_MAC)).toBe(romCrc);
    // The MAC field layout (RDATA2[15:8] first … RDATA1[7:0] last).
    expect([(efuse.read32(8) >>> 8) & 0xff, efuse.read32(8) & 0xff, efuse.read32(4) >>> 24, (efuse.read32(4) >>> 16) & 0xff, (efuse.read32(4) >>> 8) & 0xff, efuse.read32(4) & 0xff]).toEqual([...EFUSE_MAC]);
  });
});
