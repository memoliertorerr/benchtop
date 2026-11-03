import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AccessPointInfo, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createEsp32Mcu, type Esp32Mcu } from '../esp32.ts';
import { REF_HZ } from '../soc/context.ts';
import type { SocProblem } from '../soc/periph.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';
import { CODE_WIFI_NO_SYMBOLS } from './driver.ts';

// BT97: fixtures/sketches/esp32/wifi-scan on the ESP32 Mcu with its WiFi driver answered at the
// API (hle/ + wifi/driver.ts), found through the fixture's .syms.tsv.
const DIR = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32');
const ROM = loadCachedRom();

function boot(options: { symbols: boolean; aps?: AccessPointInfo[] }): { mcu: Esp32Mcu; serial: () => string; problems: SocProblem[] } {
  const mcu = createEsp32Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (problem) => problems.push(problem);
  mcu.load({ format: 'esp32-bin', app: new Uint8Array(readFileSync(join(DIR, 'wifi-scan.bin'))), partitions: new Uint8Array(readFileSync(join(DIR, 'wifi-scan.partitions.bin'))) });
  if (options.symbols) mcu.useSymbols(SymbolTable.fromNm(readFileSync(join(DIR, 'wifi-scan.syms.tsv'), 'utf8')));
  // A radio with access points to scan and nothing to join (the bench's LANs are BT98's tests).
  const aps = options.aps ?? [];
  mcu.joinWifi({ accessPoints: () => aps, join: () => undefined });
  let text = '';
  mcu.uart(0)?.onTransmit((byte) => {
    text += String.fromCharCode(byte);
  });
  return { mcu, serial: () => text, problems };
}

function runUntil(mcu: Esp32Mcu, seconds: number, until: () => boolean): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 100));
    if (result.reason === 'halted') throw new Error(result.detail ?? 'halted');
  }
}

describe('WiFi at the driver API (BT97)', () => {
  it('runs WiFi.mode(WIFI_STA) and a scan without touching the radio: no access points, scan done 0', () => {
    const { mcu, serial } = boot({ symbols: true });
    runUntil(mcu, 4, () => serial().includes('scan done'));
    expect(serial()).toContain('scan done 0\n');
    expect(mcu.soc.periph.radioAccesses).toBe(0);
    const wifi = mcu.wifi;
    expect(wifi?.inited).toBe(true);
    expect(wifi?.started).toBe(true);
    expect(wifi?.mode).toBe(1);
    // WiFi.begin() set the station's SSID; with no such network the connect ends in NO_AP_FOUND.
    expect(wifi?.staConfig.subarray(0, 8)).toEqual(Uint8Array.from([...'benchtop'].map((c) => c.charCodeAt(0))));
  });

  it('lists the access points in range, strongest first, after the time a scan takes', () => {
    const aps: AccessPointInfo[] = [
      { ssid: 'other', bssid: [2, 0, 0, 0, 0, 2], channel: 11, rssi: -70, security: 'open', password: '', hidden: false },
      { ssid: 'benchtop', bssid: [2, 0, 0, 0, 0, 1], channel: 6, rssi: -40, security: 'wpa2', password: 'simulated', hidden: false },
      { ssid: 'hidden', bssid: [2, 0, 0, 0, 0, 3], channel: 1, rssi: -30, security: 'wpa2', password: 'xxxxxxxx', hidden: true },
    ];
    const { mcu, serial } = boot({ symbols: true, aps });
    runUntil(mcu, 4, () => serial().includes('scan done'));
    const lines = serial().split('\n');
    const start = lines.findIndex((line) => line.startsWith('benchtop'));
    expect(lines.slice(start, start + 3)).toEqual(['benchtop -40 3', 'other -70 0', 'scan done 2']);
    // Arduino scans with min 100 / max 300 ms per channel: 300 on channels 6 and 11, 100 on 11 others.
    expect(mcu.cycles / REF_HZ).toBeGreaterThan(1.7);
    expect(mcu.soc.periph.radioAccesses).toBe(0);
  });

  it('reports a WiFi firmware without symbols the first time it touches the radio', () => {
    const { mcu, problems } = boot({ symbols: false });
    runUntil(mcu, 0.5, () => problems.some((p) => p.code === CODE_WIFI_NO_SYMBOLS));
    const problem = problems.find((p) => p.code === CODE_WIFI_NO_SYMBOLS);
    expect(problem?.severity).toBe('error');
    expect(problem?.message).toMatch(/symbols/);
    expect(mcu.wifi).toBeNull();
  });
});
