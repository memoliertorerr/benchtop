import { SymbolTable } from '@benchtop/core';
import type { SocProblem } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import * as T from '../../esp32/src/wifi/types.ts';
import { CODE_S2_WIFI_NO_SYMBOLS, createEsp32s2Mcu, esp32s2McuFactory, type Esp32s2Mcu, S2_HLE_RESUME_PC, S2_HLE_RETURN_PC, S2_WIFI_TASK_PC } from './esp32s2-mcu.ts';
import { REF_HZ, S2_EFUSE_MAC } from './soc/rtc-cntl.ts';
import { isRadioBlock, isRadioPowerControl } from './soc/periph.ts';
import { bootS2Fixture, s2FixtureImage } from './test-support/boot.test-helper.ts';
import { cachedS2Rom, loadCachedS2Rom } from './test-support/rom.test-helper.ts';

// BT151: what the ESP32-S2 needs for the ESP32's WiFi driver — its struct layouts, HLE addresses
// the firmware never executes, a radio that says when the closed driver runs, its own MAC.

const ROM = loadCachedS2Rom();

function boot(name: string, symbols: boolean): { mcu: Esp32s2Mcu; problems: SocProblem[] } {
  const mcu = createEsp32s2Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...s2FixtureImage(name) });
  if (symbols) mcu.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32s2/${name}.syms.tsv`)));
  return { mcu, problems };
}

function run(mcu: Esp32s2Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
}

describe('WiFi on the ESP32-S2: the pieces (BT151)', () => {
  it('wifi-layout: the S2 toolchain lays out the WiFi API exactly as the ESP32’s (types.ts) — wifi_sta_list_t too, 15 stations', () => {
    const { soc, uart } = bootS2Fixture('wifi-layout');
    for (let i = 0; i < 1500 && !uart[0].includes('layout done'); i++) soc.runUntil(soc.now() + REF_HZ / 1000);
    const line = (name: string): number[] => {
      const match = new RegExp(`^${name} ([\\d ]+)\\r?$`, 'm').exec(uart[0]);
      if (match === null) throw new Error(`no ${name} line in ${JSON.stringify(uart[0])}`);
      return match[1].trim().split(' ').map(Number);
    };
    const R = T.AP_RECORD;
    expect(line('ap_record')).toEqual([R.SIZE, R.BSSID, R.SSID, R.PRIMARY, R.SECOND, R.RSSI, R.AUTHMODE, R.PAIRWISE, R.GROUP, R.ANT, R.PHY, R.COUNTRY]);
    const S = T.STA_CONFIG;
    expect(line('sta_config')).toEqual([S.SIZE, S.SSID, S.PASSWORD, S.SCAN_METHOD, S.BSSID_SET, S.BSSID, S.CHANNEL, S.LISTEN_INTERVAL, S.SORT_METHOD, S.THRESHOLD]);
    const A = T.AP_CONFIG;
    expect(line('ap_config')).toEqual([A.SIZE, A.SSID, A.PASSWORD, A.SSID_LEN, A.CHANNEL, A.AUTHMODE, A.SSID_HIDDEN, A.MAX_CONNECTION]);
    const C = T.SCAN_CONFIG;
    expect(line('scan_config')).toEqual([C.SIZE, C.SSID, C.BSSID, C.CHANNEL, C.SHOW_HIDDEN, C.SCAN_TYPE, C.ACTIVE_MIN, C.ACTIVE_MAX, C.PASSIVE]);
    expect(line('scan_done')).toEqual([T.SCAN_DONE.SIZE, T.SCAN_DONE.STATUS, T.SCAN_DONE.NUMBER, T.SCAN_DONE.SCAN_ID]);
    const K = T.STA_CONNECTED;
    expect(line('sta_connected')).toEqual([K.SIZE, K.SSID, K.SSID_LEN, K.BSSID, K.CHANNEL, K.AUTHMODE]);
    const D = T.STA_DISCONNECTED;
    expect(line('sta_disconnected')).toEqual([D.SIZE, D.SSID, D.SSID_LEN, D.BSSID, D.REASON, D.RSSI]);
    const Y = T.COUNTRY;
    expect(line('country')).toEqual([Y.SIZE, Y.CC, Y.SCHAN, Y.NCHAN, Y.MAX_TX_POWER, Y.POLICY]);
    expect(line('sta_list')).toEqual([T.STA_LIST.SIZE, T.STA_LIST.NUM]);
  });

  it('the HLE addresses are in the ROM’s gap between .text and .rodata, which nothing fills', () => {
    // .rodata's data view 0x3FFAxxxx is the ROM's 0x4001xxxx (the second 64 KB).
    const sections = cachedS2Rom().code.map((s) => {
      const start = s.address >= 0x40000000 ? s.address : s.address - 0x3ffa0000 + 0x40010000;
      return [start, start + s.data.length];
    });
    for (const pc of [S2_HLE_RESUME_PC, S2_HLE_RETURN_PC, S2_WIFI_TASK_PC, S2_WIFI_TASK_PC + 4]) {
      expect(sections.some(([start, end]) => pc >= start && pc < end)).toBe(false);
      expect(pc).toBeGreaterThan(0x4001bed4);
      expect(pc).toBeLessThan(0x4001c600);
    }
    const mcu = createEsp32s2Mcu({ rom: ROM });
    mcu.load({ format: 'esp32-bin', ...s2FixtureImage('blink') });
    for (const pc of [S2_HLE_RESUME_PC, S2_WIFI_TASK_PC]) expect(mcu.soc.bus.read32(pc)).toBe(0);
  });

  it('a sketch without WiFi: only rtc_init’s radio power controls are touched — no radio access, no WiFi Problem', () => {
    const { mcu, problems } = boot('blink', false);
    run(mcu, 0.4);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
    expect(problems.filter((p) => p.code.startsWith('esp32s2-wifi'))).toEqual([]);
    expect(isRadioBlock(0x3f41d054) && isRadioPowerControl(0x3f41d054)).toBe(true);
    expect(isRadioBlock(0x6001d054) && isRadioPowerControl(0x6001d054)).toBe(true); // PeriBus2
    expect(isRadioBlock(0x3f406000) && !isRadioPowerControl(0x3f406000)).toBe(true);
  });

  it('a WiFi sketch without symbols runs the closed driver into the radio: esp32s2-wifi-no-symbols, once', () => {
    const { mcu, problems } = boot('wifi-scan', false);
    run(mcu, 0.5, () => problems.some((p) => p.code === CODE_S2_WIFI_NO_SYMBOLS));
    run(mcu, 0.02);
    expect(mcu.wifi).toBeNull();
    expect(mcu.soc.periph.radioAccesses).toBeGreaterThan(0);
    expect(problems.filter((p) => p.code === CODE_S2_WIFI_NO_SYMBOLS)).toHaveLength(1);
  });

  it('with its symbols the driver answers at the API on the core, and a reset keeps it', () => {
    const { mcu } = boot('wifi-scan', true);
    expect(mcu.wifi).not.toBeNull();
    run(mcu, 0.4);
    mcu.reset();
    expect(mcu.wifi).not.toBeNull();
    run(mcu, 0.4);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
  });

  it('the factory gives each board its own MAC (7C:DF:A1 and a hash of the part id); the default is the eFuse’s', () => {
    const factory = esp32s2McuFactory(ROM);
    const board = { mcu: 'esp32s2' } as Parameters<typeof factory>[0];
    const one = (factory(board, 's2') as Esp32s2Mcu).soc.efuse.mac;
    const two = (factory(board, 's2b') as Esp32s2Mcu).soc.efuse.mac;
    expect(one.slice(0, 3)).toEqual([0x7c, 0xdf, 0xa1]);
    expect(one).not.toEqual(two);
    expect(createEsp32s2Mcu({ rom: ROM }).soc.efuse.mac).toEqual(S2_EFUSE_MAC);
  });
});
