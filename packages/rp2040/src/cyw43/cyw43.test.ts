import { type BoardSpec, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText, withheldFirmware } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { rp2040McuFactory } from '../index.ts';
import { CODE_CYW43_NO_SYMBOLS, createRp2040Mcu, RP2040_CLOCK_HZ, type Rp2040Mcu } from '../rp2040-mcu.ts';
import { runMs } from '../rp2040.test-helper.ts';
import { EVENT, PICO_W_MAC, SCAN_OPTIONS, SCAN_RESULT, scanResultBytes } from './cyw43.ts';

// BT110: the Pico W's CYW43439 answered at its driver's ll layer, on fixtures/sketches/picow/blink
// (the LED on the chip's WL_GPIO0, "led 1"/"led 0" on USB serial every 500 ms).

// The published repository leaves the Pico W firmware out (THIRD_PARTY_NOTICES.md): skipped there, never here.
const WITHHELD = withheldFirmware('picow/blink.uf2') !== undefined;
const UF2 = WITHHELD ? new Uint8Array(0) : readFixture('fixtures/firmware/picow/blink.uf2');
const SYMBOLS = SymbolTable.fromNm(WITHHELD ? '' : readFixtureText('fixtures/firmware/picow/blink.syms.tsv'), true);

function boot(symbols: boolean): { mcu: Rp2040Mcu; serial: () => string; problems: string[]; edges: [number, number][] } {
  const problems: string[] = [];
  const mcu = createRp2040Mcu({ cyw43: {}, onProblem: (p) => problems.push(p.code) });
  mcu.load({ format: 'uf2', bytes: UF2 });
  if (symbols) mcu.useSymbols(SYMBOLS);
  let text = '';
  mcu.uart(0)?.onTransmit((b) => (text += String.fromCharCode(b)));
  const led = mcu.pins.get('WL_GPIO0');
  if (led === undefined) throw new Error('no WL_GPIO0');
  const edges: [number, number][] = [];
  led.onOutputChange(() => edges.push([(mcu.cycles / RP2040_CLOCK_HZ) * 1000, led.outputLevel()]));
  return { mcu, serial: () => text, problems, edges };
}

describe.skipIf(WITHHELD)('the Pico W’s CYW43 at its driver API (BT110)', () => {
  it('blink: the LED on WL_GPIO0 toggles every 500 ms through cyw43_ll_gpio_set', () => {
    const { mcu, serial, problems, edges } = boot(true);
    runMs(mcu, 2200);
    expect(edges.map(([, level]) => level)).toEqual([1, 0, 1, 0, 1]);
    for (let i = 1; i < edges.length; i++) expect(edges[i][0] - edges[i - 1][0]).toBeCloseTo(500, 0);
    expect(serial()).toContain('led 1\r\nled 0\r\nled 1\r\n');
    const calls = mcu.cyw43?.calls;
    expect(calls?.get('cyw43_ll_bus_init')).toBe(1); // the chip came up once (cyw43_ensure_up)
    expect(calls?.get('cyw43_ll_wifi_get_mac')).toBe(1); // the MAC from OTP
    expect(calls?.get('cyw43_ll_gpio_set')).toBe(5);
    expect(calls?.get('cyw43_ll_has_work')).toBeGreaterThan(10); // the driver's poll keeps running
    expect(problems).not.toContain(CODE_CYW43_NO_SYMBOLS);
  });

  it('a reset keeps the chip answered: the LED blinks again', () => {
    const { mcu, edges } = boot(true);
    runMs(mcu, 600);
    mcu.reset();
    edges.length = 0;
    expect(mcu.pins.get('WL_GPIO0')?.outputLevel()).toBe(0); // the chip powered off with the board
    runMs(mcu, 600);
    expect(edges.map(([, level]) => level)).toEqual([1, 0]); // on, then off, from the fresh boot
  });

  it('without symbols the real driver powers the chip (WL_REG_ON): rp2040-cyw43-no-symbols once, the LED stays dark', () => {
    const { mcu, serial, problems, edges } = boot(false);
    runMs(mcu, 1500);
    expect(problems.filter((p) => p === CODE_CYW43_NO_SYMBOLS)).toHaveLength(1);
    expect(edges).toEqual([]);
    expect(serial()).toContain('led 1'); // the sketch itself runs on
  });

  it('a Pico has no CYW43: no WL_GPIO0, symbols change nothing', () => {
    const mcu = createRp2040Mcu();
    expect(mcu.cyw43).toBeNull();
    expect(mcu.pins.has('WL_GPIO0')).toBe(false);
    mcu.useSymbols(SYMBOLS);
    expect(mcu.hle).toBeNull();
  });

  it('the factory makes a Pico W of a board that maps WL_GPIO0, its MAC 28:CD:C1 and a hash of the part id', () => {
    const picoW: BoardSpec = { mcu: 'rp2040', pinMap: { WL_GPIO0: 'WL_GPIO0', GP0: 'GPIO0' } };
    const one = rp2040McuFactory(picoW, 'pw1') as Rp2040Mcu;
    const two = rp2040McuFactory(picoW, 'pw2') as Rp2040Mcu;
    const pico = rp2040McuFactory({ mcu: 'rp2040', pinMap: { TP5: 'GPIO25' } }, 'p') as Rp2040Mcu;
    expect(pico.cyw43).toBeNull();
    for (const mcu of [one, two]) expect(mcu.pins.has('WL_GPIO0')).toBe(true);
    const mac = (mcu: Rp2040Mcu): number[] => (mcu.cyw43 as unknown as { host: { mac: number[] } }).host.mac;
    expect(mac(one).slice(0, 3)).toEqual([0x28, 0xcd, 0xc1]);
    expect(mac(one)).not.toEqual(mac(two));
    expect((createRp2040Mcu({ cyw43: {} }).cyw43 as unknown as { host: { mac: number[] } }).host.mac).toEqual(PICO_W_MAC);
  });

  it('BT111: the event and scan structs the model writes are the Pico W toolchain’s (wifi-layout)', () => {
    const mcu = createRp2040Mcu({ cyw43: {} });
    mcu.load({ format: 'uf2', bytes: readFixture('fixtures/firmware/picow/wifi-layout.uf2') });
    mcu.useSymbols(SymbolTable.fromNm(readFixtureText('fixtures/firmware/picow/wifi-layout.syms.tsv'), true));
    let text = '';
    mcu.uart(0)?.onTransmit((b) => (text += String.fromCharCode(b)));
    for (let ms = 0; ms < 2000 && !text.includes('layout done'); ms += 10) runMs(mcu, 10);
    const line = (name: string): number[] => {
      const match = new RegExp(`^${name} ([\\d ]+)\\r?$`, 'm').exec(text);
      if (match === null) throw new Error(`no ${name} line in ${JSON.stringify(text)}`);
      return match[1].trim().split(' ').map(Number);
    };
    expect(line('async_event')).toEqual([EVENT.SIZE, EVENT.FLAGS, EVENT.TYPE, EVENT.STATUS, EVENT.REASON, EVENT.INTERFACE, EVENT.SCAN]);
    expect(line('scan_result')).toEqual([SCAN_RESULT.SIZE, SCAN_RESULT.BSSID, SCAN_RESULT.SSID_LEN, SCAN_RESULT.SSID, SCAN_RESULT.CHANNEL, SCAN_RESULT.AUTH_MODE, SCAN_RESULT.RSSI]);
    expect(line('scan_options')).toEqual([SCAN_OPTIONS.SIZE, SCAN_OPTIONS.SSID_LEN, SCAN_OPTIONS.SSID]);
    // a scan result as cyw43_ll.c leaves it: WPA2 is auth_mode 5 (RSN + privacy), rssi signed
    const bytes = scanResultBytes({ ssid: 'bench', bssid: [2, 0, 0, 0, 0, 1], channel: 6, rssi: -50, security: 'wpa2', password: 'x', hidden: false });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(EVENT.TYPE, true)).toBe(69);
    expect(view.getUint32(EVENT.STATUS, true)).toBe(8);
    expect(bytes[EVENT.SCAN + SCAN_RESULT.SSID_LEN]).toBe(5);
    expect(bytes[EVENT.SCAN + SCAN_RESULT.AUTH_MODE]).toBe(5);
    expect(view.getInt16(EVENT.SCAN + SCAN_RESULT.RSSI, true)).toBe(-50);
    expect(view.getUint16(EVENT.SCAN + SCAN_RESULT.CHANNEL, true)).toBe(6);
  });
});
