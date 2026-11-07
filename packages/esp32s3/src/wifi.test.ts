import { SymbolTable } from '@benchtop/core';
import type { SocProblem } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import * as T from '../../esp32/src/wifi/types.ts';
import { CODE_S3_WIFI_NO_SYMBOLS, createEsp32s3Mcu, esp32s3McuFactory, type Esp32s3Mcu, S3_HLE_RESUME_PC, S3_HLE_RETURN_PC, S3_WIFI_TASK_PC } from './esp32s3-mcu.ts';
import { REF_HZ, S3_EFUSE_MAC } from './soc/rtc-cntl.ts';
import { isRadioBlock, isRadioPowerControl } from './soc/periph.ts';
import { bootS3Fixture, s3FixtureImage } from './test-support/boot.test-helper.ts';
import { cachedS3Rom, loadCachedS3Rom } from './test-support/rom.test-helper.ts';

// BT127: what the ESP32-S3 needs for the ESP32's WiFi driver — its struct layouts, HLE addresses
// the firmware never executes, a radio that says when the closed driver runs, its own MAC.

const ROM = loadCachedS3Rom();

function boot(name: string, symbols: boolean): { mcu: Esp32s3Mcu; problems: SocProblem[] } {
  const mcu = createEsp32s3Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...s3FixtureImage(name) });
  if (symbols) mcu.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32s3/${name}.syms.tsv`)));
  return { mcu, problems };
}

function run(mcu: Esp32s3Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
}

describe('WiFi on the ESP32-S3: the pieces (BT127)', () => {
  it('wifi-layout: the S3 toolchain lays out the WiFi API exactly as the ESP32’s (types.ts) — wifi_sta_list_t too, 15 stations', () => {
    const { soc, uart } = bootS3Fixture('wifi-layout');
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
    const sections = cachedS3Rom().code.map((s) => {
      const start = s.address >= 0x40000000 ? s.address : s.address - 0x3ff00000 + 0x40040000;
      return [start, start + s.data.length];
    });
    for (const pc of [S3_HLE_RESUME_PC, S3_HLE_RETURN_PC, S3_WIFI_TASK_PC, S3_WIFI_TASK_PC + 4]) {
      expect(sections.some(([start, end]) => pc >= start && pc < end)).toBe(false);
      expect(pc).toBeGreaterThan(0x400577a8);
      expect(pc).toBeLessThan(0x40058c00);
    }
    const mcu = createEsp32s3Mcu({ rom: ROM });
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage('blink') });
    for (const pc of [S3_HLE_RESUME_PC, S3_WIFI_TASK_PC]) expect(mcu.soc.buses[0].read32(pc)).toBe(0);
  });

  it('a sketch without WiFi: only rtc_init’s radio power controls are touched — no radio access, no WiFi Problem', () => {
    const { mcu, problems } = boot('blink', false);
    run(mcu, 0.4);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
    expect(problems.filter((p) => p.code.startsWith('esp32s3-wifi'))).toEqual([]);
    expect(isRadioBlock(0x6001d054) && isRadioPowerControl(0x6001d054)).toBe(true);
    expect(isRadioBlock(0x60006000) && !isRadioPowerControl(0x60006000)).toBe(true);
  });

  it('a WiFi sketch without symbols runs the closed driver into the radio: esp32s3-wifi-no-symbols, once', () => {
    const { mcu, problems } = boot('wifi-scan', false);
    run(mcu, 0.5, () => problems.some((p) => p.code === CODE_S3_WIFI_NO_SYMBOLS));
    run(mcu, 0.02);
    expect(mcu.wifi).toBeNull();
    expect(mcu.soc.periph.radioAccesses).toBeGreaterThan(0);
    expect(problems.filter((p) => p.code === CODE_S3_WIFI_NO_SYMBOLS)).toHaveLength(1);
  });

  it('with its symbols the driver answers at the API on both cores, and a reset keeps it', () => {
    const { mcu } = boot('wifi-scan', true);
    expect(mcu.wifi).not.toBeNull();
    run(mcu, 0.4);
    mcu.reset();
    expect(mcu.wifi).not.toBeNull();
    run(mcu, 0.4);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
  });

  it('the factory gives each board its own MAC (34:85:18 and a hash of the part id); the default is the eFuse’s', () => {
    const factory = esp32s3McuFactory(ROM);
    const board = { mcu: 'esp32s3' } as Parameters<typeof factory>[0];
    const one = (factory(board, 's3') as Esp32s3Mcu).soc.efuse.mac;
    const two = (factory(board, 's3b') as Esp32s3Mcu).soc.efuse.mac;
    expect(one.slice(0, 3)).toEqual([0x34, 0x85, 0x18]);
    expect(one).not.toEqual(two);
    expect(createEsp32s3Mcu({ rom: ROM }).soc.efuse.mac).toEqual(S3_EFUSE_MAC);
  });
});
