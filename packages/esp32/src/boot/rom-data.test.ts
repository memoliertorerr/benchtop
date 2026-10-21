import { describe, expect, it } from 'vitest';
import { cachedRom } from '../test-support/boot.test-helper.ts';
import { Esp32Soc } from '../soc/soc.ts';
import { ROM_STORE_TABLE, ROM_STORE_TABLE_END, unpackRomData } from './rom.ts';

// BT32: the ROM's RAM data, initialized as its reset handler's unpackloop does from
// _rom_store_table (entries {start, end, source, always}), matches the ROM ELF's .data_*
// sections — and the PHY function table pointer that rom_i2c_writeReg dereferences (0x3ffae0c0,
// table-initialized) points into the ROM.

describe('ROM .data initialization', () => {
  it('unpacks the table into RAM as the ELF says, PHY function table included', () => {
    const rom = cachedRom();
    const soc = new Esp32Soc();
    soc.loadRom(rom);
    const bus = soc.buses[0];
    expect(unpackRomData(bus)).toBe((ROM_STORE_TABLE_END - ROM_STORE_TABLE) / 16);
    const entries: [number, number][] = [];
    for (let e = ROM_STORE_TABLE; e < ROM_STORE_TABLE_END; e += 16) entries.push([bus.read32(e), bus.read32(e + 4)]);
    const covered = rom.data.filter((s) => entries.some(([start, end]) => s.address < end && s.address + s.data.length > start));
    // .data_btdm is copied by the BT stack's own btdm_r_data_init; the _app copies by the APP_CPU.
    expect(covered.map((s) => s.name).sort()).toEqual(['.data_c', '.data_etsc_pro', '.data_phyrom', '.data_spi_flash', '.data_xtos_pro']);
    for (const section of covered) {
      for (let i = 0; i < section.data.length; i++) {
        if (bus.read8(section.address + i) !== section.data[i]) throw new Error(`${section.name}+${i}: ${bus.read8(section.address + i)} ≠ ${section.data[i]}`);
      }
    }
    const phyTable = bus.read32(0x3ffae0c0);
    expect(phyTable).toBe(new DataView(rom.data.find((s) => s.name === '.data_phyrom')!.data.buffer, rom.data.find((s) => s.name === '.data_phyrom')!.data.byteOffset).getUint32(0, true));
    expect(phyTable >= 0x3ff00000 && phyTable < 0x40070000).toBe(true);
  });

  it('the APP_CPU unpacks its per-CPU copies through its relocated window, not over the PRO_CPU\'s', () => {
    const soc = new Esp32Soc();
    soc.loadRom(cachedRom());
    const [pro, app] = soc.buses;
    unpackRomData(pro);
    pro.write32(0x3ffe01e0, 240); // g_ticks_per_us_pro, as ets_update_cpu_frequency leaves it
    unpackRomData(app, false);
    expect(pro.read32(0x3ffe01e0)).toBe(240);
    expect(pro.read32(0x3ffe40f0)).toBe(13); // g_ticks_per_us_app = .data_etsc_app's initial value
    expect(app.read32(0x3ffe01e0)).toBe(13);
  });
});
