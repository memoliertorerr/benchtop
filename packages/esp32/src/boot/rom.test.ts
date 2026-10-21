import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';
import { sha256Hex } from '../util/sha256.ts';
import * as manifest from './rom-manifest.ts';
import { parseRomElf } from './rom.ts';

describe('ESP32 ROM', () => {
  it('rom-manifest.ts pins 64-hex SHA-256s (a committed placeholder fails)', () => {
    expect(manifest.ROM_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.ROM_ELF_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.ROM_ELF_NAME).toBe('esp32_rev0_rom.elf');
    expect(manifest.ROM_TARBALL_URL).toBe('https://github.com/espressif/esp-rom-elfs/releases/download/20241011/esp-rom-elfs-20241011.tar.gz');
  });

  it('the cached ROM ELF verifies and has the symbols the core’s esp32.rom.ld names', () => {
    const bytes = loadCachedRom();
    expect(sha256Hex(bytes)).toBe(manifest.ROM_ELF_SHA256);
    const rom = parseRomElf(bytes);
    expect(rom.symbols.get('_rom_store_table')).toBe(0x4000d4f8);
    expect(rom.symbols.get('ets_printf')).toBe(0x40007d54);
    // esp32.rom.ld PROVIDEs Cache_Read_Enable_rom = 0x40009a84; the ROM ELF names that routine
    // Cache_Read_Enable.
    expect(rom.symbols.get('Cache_Read_Enable')).toBe(0x40009a84);
    expect(rom.segments.length).toBeGreaterThan(0);
  });

  it('loadCachedRom says how to fetch a missing ROM, and refuses a wrong one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchtop-rom-'));
    try {
      expect(() => loadCachedRom(dir)).toThrow(/run npm run fetch:esp32-rom/);
      writeFileSync(join(dir, manifest.ROM_ELF_NAME), 'not a rom');
      expect(() => loadCachedRom(dir)).toThrow(/has SHA-256 [0-9a-f]{64}, expected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
