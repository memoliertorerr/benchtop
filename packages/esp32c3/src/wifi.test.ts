import { SymbolTable } from '@benchtop/core';
import { STA_LIST_C3, type SocProblem } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import * as T from '../../esp32/src/wifi/types.ts';
import { C3_HLE_RESUME_PC, C3_WIFI_TASK_PC, CODE_C3_WIFI_NO_SYMBOLS, createEsp32c3Mcu, esp32c3McuFactory, type Esp32c3Mcu } from './esp32c3-mcu.ts';
import { APB_CTRL_BASE } from './soc/apb-ctrl.ts';
import { REF_HZ } from './soc/context.ts';
import { isRadioBlock, isRadioPowerControl } from './soc/periph.ts';
import { EFUSE_MAC } from './soc/rtc-cntl.ts';
import { bootC3Fixture, fixtureImage } from './test-support/boot.test-helper.ts';
import { cachedC3Rom, loadCachedC3Rom } from './test-support/rom.test-helper.ts';

// BT107: what the ESP32-C3 needs for the ESP32's WiFi driver — the same struct layouts, a radio
// that says when the closed driver runs, a random number generator, its own MAC.

const ROM = loadCachedC3Rom();

function boot(name: string, symbols: boolean): { mcu: Esp32c3Mcu; problems: SocProblem[] } {
  const mcu = createEsp32c3Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...fixtureImage(name) });
  if (symbols) mcu.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32c3/${name}.syms.tsv`)));
  return { mcu, problems };
}

function run(mcu: Esp32c3Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
}

describe('WiFi on the ESP32-C3: the pieces (BT107)', () => {
  it('wifi-layout: the C3 toolchain lays out the WiFi API like the ESP32 (types.ts), but for wifi_sta_list_t (10 stations)', () => {
    const { soc, uart } = bootC3Fixture('wifi-layout');
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
    expect(line('sta_list')).toEqual([STA_LIST_C3.SIZE, STA_LIST_C3.NUM]);
  });

  it('the HLE addresses are in the ROM’s gap between .text and .rodata, which nothing fills', () => {
    const sections = cachedC3Rom().code.map((s) => {
      const start = s.address >= 0x40000000 ? s.address : s.address - 0x3ff00000 + 0x40040000;
      return [start, start + s.data.length];
    });
    for (const pc of [C3_HLE_RESUME_PC, C3_WIFI_TASK_PC, C3_WIFI_TASK_PC + 4]) {
      expect(sections.some(([start, end]) => pc >= start && pc < end)).toBe(false);
      expect(pc).toBeGreaterThan(0x40000000);
      expect(pc).toBeLessThan(0x40060000);
    }
  });

  it('a sketch without WiFi: only rtc_init’s radio power controls are touched — no radio access, no WiFi Problem', () => {
    const { mcu, problems } = boot('blink', false);
    run(mcu, 0.3);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
    expect(problems.filter((p) => p.code.startsWith('esp32c3-wifi'))).toEqual([]);
    expect(isRadioBlock(0x6001d054) && isRadioPowerControl(0x6001d054)).toBe(true);
    expect(isRadioBlock(0x60006000) && !isRadioPowerControl(0x60006000)).toBe(true);
  });

  it('a WiFi sketch without symbols runs the closed driver into the radio: esp32c3-wifi-no-symbols, once', () => {
    const { mcu, problems } = boot('wifi-scan', false);
    // The closed driver then polls the analog through RTC_I2C forever — slow to simulate: stop at the report.
    run(mcu, 0.3, () => problems.some((p) => p.code === CODE_C3_WIFI_NO_SYMBOLS));
    run(mcu, 0.02);
    expect(mcu.wifi).toBeNull();
    expect(mcu.soc.periph.radioAccesses).toBeGreaterThan(0);
    expect(problems.filter((p) => p.code === CODE_C3_WIFI_NO_SYMBOLS)).toHaveLength(1);
  });

  it('with its symbols the driver answers at the API, and a reset keeps it', () => {
    const { mcu } = boot('wifi-scan', true);
    expect(mcu.wifi).not.toBeNull();
    run(mcu, 0.3);
    mcu.reset();
    expect(mcu.wifi).not.toBeNull();
    expect(mcu.soc.core.hle).not.toBeNull();
    run(mcu, 0.3);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
  });

  it('APB_CTRL’s WDEV_RND_REG gives a new number on every read, the same sequence every boot', () => {
    const read = (): number[] => {
      const mcu = createEsp32c3Mcu({ rom: ROM });
      return [0, 1, 2, 3].map(() => mcu.soc.periph.read32(APB_CTRL_BASE + 0xb0, 0));
    };
    const a = read();
    expect(new Set(a).size).toBe(4);
    expect(read()).toEqual(a);
  });

  it('the factory gives each board its own MAC (34:85:18 and a hash of the part id); the default is the eFuse’s', () => {
    const factory = esp32c3McuFactory(ROM);
    const board = { mcu: 'esp32c3' } as Parameters<typeof factory>[0];
    const one = (factory(board, 'c3') as Esp32c3Mcu).soc.rtc.mac;
    const two = (factory(board, 'c3b') as Esp32c3Mcu).soc.rtc.mac;
    expect(one.slice(0, 3)).toEqual([0x34, 0x85, 0x18]);
    expect(two.slice(0, 3)).toEqual([0x34, 0x85, 0x18]);
    expect(one).not.toEqual(two);
    expect(createEsp32c3Mcu({ rom: ROM }).soc.rtc.mac).toEqual(EFUSE_MAC);
  });
});
